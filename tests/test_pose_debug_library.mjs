import assert from "node:assert/strict";
import test from "node:test";
import { createScene } from "./helpers/pose_studio_scene.mjs";

const pose = { name: "Saved", asset_type: "pose", preview_mtime: 1, data: { bones: {} } };
const response = poses => ({ ok: true, json: async () => ({ poses }) });
function harness() {
    const scene = createScene();
    scene.w.exportParams.debugMode = true;
    scene.w.renderLibrary = () => {};
    scene.context.console = { ...console, error() {} };
    return scene;
}

test("metadata refreshes and concurrent executions share the pending full library load", async () => {
    const { w, context } = harness();
    const requests = [];
    context.fetch = url => new Promise(resolve => requests.push({ url, resolve }));
    const firstRun = w.ensureDebugLibraryReady();
    const metadata = w.refreshLibrary(false);
    const secondRun = w.ensureDebugLibraryReady();
    // Settle every request to reproduce the old cancellation without leaving pending promises.
    for (const request of requests) request.resolve(response(
        request.url.endsWith("true") ? [pose] : [{ ...pose, data: null }],
    ));
    await Promise.all([firstRun, metadata, secondRun]);
    assert.deepEqual(requests.map(request => request.url), ["/vnccs/pose_library/list?full=true"]);
    assert.equal(w.getDebugLibraryPoseCandidates().length, 1);
    assert.equal(w.selectRandomDebugLibraryPose(() => 0).bones !== undefined, true);
    assert.equal(w._libraryFullRefreshPromise, null);
});

test("an older metadata response cannot overwrite the execution's full library", async () => {
    const { w, context } = harness();
    const requests = [];
    context.fetch = url => new Promise(resolve => requests.push({ url, resolve }));
    const metadata = w.refreshLibrary(false);
    const ready = w.ensureDebugLibraryReady();
    requests[1].resolve(response([pose]));
    await ready;
    requests[0].resolve(response([{ ...pose, data: null }]));
    await metadata;
    assert.equal(w.getDebugLibraryPoseCandidates().length, 1);
});

test("metadata refresh preserves loaded data for unchanged poses and drops deleted or updated records", async () => {
    const { w, context } = harness();
    w.libraryPoses = [pose, { ...pose, name: "Deleted" }, { ...pose, name: "Updated" }];
    context.fetch = async () => response([
        { ...pose, data: null }, { ...pose, name: "Updated", preview_mtime: 2, data: null },
    ]);
    await w.refreshLibrary(false);
    assert.deepEqual(w.libraryPoses.map(item => item.name), ["Saved", "Updated"]);
    assert.equal(w.libraryPoses[0].data, pose.data);
    assert.equal(w.libraryPoses[1].data, null);
    assert.equal(w.getDebugLibraryPoseCandidates().length, 1);
});

for (const failure of ["HTTP error", "network error", "invalid response", "empty library"]) {
    test(`Debug readiness reports ${failure} and allows a later retry`, async () => {
        const { w, context } = harness();
        context.fetch = async () => {
            if (failure === "network error") throw new Error("Network unavailable");
            return {
                ok: failure !== "HTTP error", status: 500,
                json: async () => failure === "HTTP error" ? { error: "Library storage unavailable" }
                    : failure === "invalid response" ? {} : { poses: [] },
            };
        };
        const expected = failure === "HTTP error" ? /Library storage unavailable/
            : failure === "network error" ? /Network unavailable/
                : failure === "invalid response" ? /Library items could not be loaded/
                    : /requires at least one fully loaded library pose/;
        await assert.rejects(w.ensureDebugLibraryReady(), expected);
        assert.equal(w._libraryFullRefreshPromise, null);
        context.fetch = async () => response([pose]);
        await w.ensureDebugLibraryReady();
        assert.equal(w.getDebugLibraryPoseCandidates().length, 1);
    });
}
