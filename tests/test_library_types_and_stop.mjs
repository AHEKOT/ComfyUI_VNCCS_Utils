import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const poseSource = readFileSync(new URL("../web/vnccs_pose_studio.js", import.meta.url), "utf8");
const posePrototype = vm.runInNewContext(
    poseSource.slice(poseSource.indexOf("class PoseStudioWidget {"), poseSource.indexOf("// === ComfyUI Extension Registration ===")) + "\nPoseStudioWidget.prototype",
    { URLSearchParams },
);

test("same-name poses and animations use distinct IDs and typed request URLs", () => {
    const pose = { name: "Walk", repository: "artist/poses", category: "Standing", asset_type: "pose", has_preview: true };
    const animation = { ...pose, asset_type: "animation" };
    assert.notEqual(posePrototype.getLibraryPoseId(pose), posePrototype.getLibraryPoseId(animation));
    for (const asset of [pose, animation]) {
        const query = new URLSearchParams(posePrototype.getLibraryPoseQuery(asset));
        assert.equal(query.get("asset_type"), asset.asset_type);
        assert.equal(query.get("repository"), asset.repository);
        const preview = new URL(posePrototype.getLibraryPreviewUrl(asset), "http://localhost");
        assert.equal(preview.searchParams.get("asset_type"), asset.asset_type);
    }
});

const canvasSource = readFileSync(new URL("../web/vnccs_unicanvas.js", import.meta.url), "utf8");

function canvasWidget(fetch) {
    const prototype = vm.runInNewContext(
        canvasSource.slice(canvasSource.indexOf("class UniCanvasWidget {"), canvasSource.indexOf("\napp.registerExtension(")) + "\nUniCanvasWidget.prototype",
        { fetch, api: { addEventListener() {}, removeEventListener() {} } },
    );
    return Object.assign(Object.create(prototype), {
        drawInProgress: true, stopBtn: {}, setStatus() {}, updateGenerationProgress() {},
        _drawDebugId: "own-draw", _queuedDrawPromptId: "own-prompt",
    });
}

for (const queued of [false, true]) {
    test(`Stop scopes ${queued ? "graph" : "HTTP"} cancellation to this draw`, async () => {
        const calls = [];
        const widget = canvasWidget(async (url, options) => {
            calls.push([url, JSON.parse(options.body)]);
            if (url === "/vnccs/unicanvas/interrupt") widget._queuedDrawPromptId = null;
            return { ok: true };
        });
        widget._drawViaQueue = queued;
        await widget.stopDraw();
        assert.deepEqual(calls, [
            ["/vnccs/unicanvas/interrupt", { draw_id: "own-draw" }],
            ...(queued ? [["/queue", { delete: ["own-prompt"] }]] : []),
        ]);
        assert.equal(widget._stopRequested, true);
    });
}

test("failed Stop remains retryable", async () => {
    const widget = canvasWidget(async () => ({ ok: false, status: 500 }));
    await widget.stopDraw();
    assert.equal(widget._stopRequested, false);
    assert.equal(widget.stopBtn.disabled, false);
});

test("stopped graph draws end result polling immediately", async () => {
    const widget = canvasWidget(async () => assert.fail("Stopped draws must not poll results"));
    widget._stopRequested = true;
    await assert.rejects(widget._pollForResult("own-draw", "own-prompt"), error => error.cancelled === true);
});
