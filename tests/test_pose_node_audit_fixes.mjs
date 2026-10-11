import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { createScene, Element } from "./helpers/pose_studio_scene.mjs";
import { createPoseStudioCharacter } from "../web/pose_studio/characters.mjs";

const source = await fs.readFile(new URL("../web/vnccs_pose_studio.js", import.meta.url), "utf8");
const noop = () => {};

test("the latest library refresh wins over an older response", async () => {
    const { w, context } = createScene();
    const pending = [];
    context.fetch = () => new Promise(resolve => pending.push(resolve));
    w.renderLibrary = noop;
    const oldRefresh = w.refreshLibrary();
    const newRefresh = w.refreshLibrary();
    pending[1]({ ok: true, json: async () => ({ poses: [{ name: "New" }] }) });
    await newRefresh;
    pending[0]({ ok: true, json: async () => ({ poses: [{ name: "Old" }] }) });
    await oldRefresh;
    assert.equal(w.libraryPoses[0].name, "New");
});

for (const action of ["remove", "HTTP error", "invalid response"]) {
    test(`library refresh preserves cached poses after ${action}`, async () => {
        const { w, context } = createScene();
        const cached = w.libraryPoses = [{ name: "Saved" }];
        const grid = w.libraryGrid = new Element();
        grid.innerHTML = "Saved cards";
        const messages = [];
        w.showMessage = (text, error) => messages.push({ text, error });
        let finish, rendered = 0;
        context.fetch = () => new Promise(resolve => { finish = resolve; });
        context.console = { ...console, error: noop };
        w.renderLibrary = () => { rendered++; };
        const refresh = w.refreshLibrary();
        if (action === "remove") w._disposed = true;
        finish({ ok: action !== "HTTP error", status: 500, json: async () => action === "invalid response" ? {} : ({ poses: [] }) });
        await refresh;
        assert.equal(w.libraryPoses, cached);
        assert.equal(rendered, 0);
        assert.equal(grid.innerHTML, "Saved cards");
        assert.equal(messages.length, action === "remove" ? 0 : 1);
        if (messages.length) assert.equal(messages[0].error, true);
    });
}

for (const result of ["success", "failure"]) {
    test(`a closed repository panel ignores pending ${result}`, async () => {
        const { w, context } = createScene();
        const oldPanel = w.librarySettingsEl = new Element();
        let finish;
        context.fetch = () => new Promise((resolve, reject) => { finish = result === "success" ? resolve : reject; });
        const cached = w.poseRepositories = [{ repo_id: "old/poses" }];
        w.renderPoseRepositorySettings = () => assert.fail("The closed panel cannot render");
        const refresh = w.refreshPoseRepositories();
        w.librarySettingsEl = null;
        finish(result === "success" ? { ok: true, json: async () => ({ repositories: [] }) } : new Error("offline"));
        await refresh;
        assert.equal(w.poseRepositories, cached);
        assert.equal(oldPanel.innerHTML, '<div class="vnccs-ps-library-empty">Loading repositories...</div>');
    });
}

test("the latest repository refresh wins over an older response", async () => {
    const { w, context } = createScene();
    w.librarySettingsEl = new Element();
    w.renderPoseRepositorySettings = noop;
    const requests = [];
    context.fetch = () => new Promise(resolve => requests.push(resolve));
    const oldRefresh = w.refreshPoseRepositories();
    const newRefresh = w.refreshPoseRepositories();
    requests[1]({ ok: true, json: async () => ({ repositories: [{ repo_id: "new/poses" }] }) });
    await newRefresh;
    requests[0]({ ok: true, json: async () => ({ repositories: [{ repo_id: "old/poses" }] }) });
    await oldRefresh;
    assert.equal(w.poseRepositories[0].repo_id, "new/poses");
});

for (const action of ["workflow", "remove", "failed switch"]) {
    test(`character removal stops after ${action} while switching rigs`, async () => {
        const { w } = createScene();
        w.characters.push(createPoseStudioCharacter({ id: "character-2", mesh: w.meshParams, poses: [{}] }));
        let finish;
        w.selectCharacter = () => new Promise(resolve => { finish = resolve; });
        const removing = w.deleteCharacter(w.activeCharacterId);
        if (action === "workflow") w.characters = w.characters.map(character => ({ ...character }));
        if (action === "remove") w._disposed = true;
        const remaining = w.characters.slice();
        finish(action !== "failed switch");
        assert.equal(await removing, false);
        assert.deepEqual(w.characters, remaining);
    });
}

test("Pose Studio retains the original resize lifecycle callback and receiver", () => {
    let called = 0;
    const node = { studioWidget: { scheduleMainUIScaleCommit: noop }, size: [900, 740] };
    const nodeType = { prototype: { onResize(size, event) {
        assert.equal(this, node);
        assert.equal(size, node.size);
        assert.equal(event, "resize event");
        called++;
        return "previous result";
    } } };
    const start = source.indexOf("        const onResize = nodeType.prototype.onResize;");
    const fallback = source.indexOf("        nodeType.prototype.onResize = function (size)");
    const end = source.indexOf("        // Save state on configure", fallback);
    vm.runInNewContext(source.slice(start >= 0 ? start : fallback, end), {
        nodeType, clearTimeout: noop, setTimeout: () => 1,
        scheduleStudioDOMWidgetWidth: noop, syncStudioDOMWidgetWidth: noop,
    });
    assert.equal(nodeType.prototype.onResize.call(node, node.size, "resize event"), "previous result");
    assert.equal(called, 1);
});

function executionScene() {
    const scene = createScene();
    const handlers = new Map(), uploads = [];
    scene.node.studioWidget = scene.w;
    scene.context.api = { addEventListener: (name, handler) => handlers.set(name, handler) };
    scene.context.app.graph.getNodeById = () => scene.node;
    scene.context.console = { ...console, error: noop };
    scene.context.fetch = async (_url, options) => { uploads.push(JSON.parse(options.body)); return { ok: true }; };
    const start = source.indexOf("const waitForPoseStudioSyncIdle =");
    vm.runInNewContext(source.slice(start, source.indexOf("\n    },\n\n    async beforeRegisterNodeDef", start)), scene.context);
    return { ...scene, handlers, uploads };
}

for (const action of ["workflow", "character", "tab", "remove", "replacement widget", "edit"]) {
    test(`SAM execution cannot apply a stale pose after ${action}`, async () => {
        const { w, viewer, node, handlers, uploads } = executionScene();
        let finish, applied = 0;
        w.prepareSAM3DRenderFit = () => new Promise(resolve => { finish = resolve; });
        viewer.applySAM3DImport = () => { applied++; throw new Error("A stale pose reached the replacement scene"); };
        const running = handlers.get("vnccs_apply_sam3d_pose")({ detail: { node_id: 1, sync_token: "old", pose_data: {} } });
        if (action === "workflow") w._poseDataRestoreToken = (w._poseDataRestoreToken || 0) + 1;
        if (action === "character") w.activeCharacterId = "character-2";
        if (action === "tab") w.activeTab++;
        if (action === "remove") w._disposed = true;
        if (action === "replacement widget") node.studioWidget = {};
        if (action === "edit") w._libraryLoadToken = (w._libraryLoadToken || 0) + 1;
        finish(null);
        await running;
        assert.equal(applied, 0);
        assert.equal(uploads.at(-1).node_id, "1_old");
        assert.match(uploads.at(-1).sync_error, /changed|disposed|replaced/i);
    });
}

test("manager proportion fitting stops when its pending fit belongs to a previous scene", async () => {
    const { w, viewer } = createScene();
    let finish, applied = 0;
    w.prepareSAM3DRenderFit = () => new Promise(resolve => { finish = resolve; });
    viewer.applySAM3DImport = () => { applied++; throw new Error("Stale fit"); };
    const fitting = w.applySAM3DProportionsToPoseManager({});
    w._libraryLoadToken = (w._libraryLoadToken || 0) + 1;
    finish(null);
    assert.equal(await fitting, false);
    assert.equal(applied, 0);
});

test("ordinary execution stops when the workflow changes during library readiness", async () => {
    const { w, handlers, uploads } = executionScene();
    let finish;
    w.ensureDebugLibraryReady = () => new Promise(resolve => { finish = resolve; });
    w.syncToNode = () => assert.fail("Old execution cannot capture the new workflow");
    const running = handlers.get("vnccs_req_pose_sync")({ detail: { node_id: 1, sync_token: "old" } });
    w._poseDataRestoreToken = (w._poseDataRestoreToken || 0) + 1;
    finish();
    await running;
    assert.match(uploads.at(-1).sync_error, /scene changed/i);
    assert.equal(uploads.at(-1).captured_images, undefined);
});

function uploadFunction(context) {
    const start = source.indexOf("const poseStudioSyncGuard =");
    const end = source.indexOf("        const requirePoseStudioSyncResponse", start);
    return vm.runInNewContext(source.slice(start, end) + "\nuploadPoseStudioSync", context);
}

test("parallel execution uploads keep their own captures while animation uploads are pending", async () => {
    const { w, node, context } = createScene();
    node.studioWidget = w;
    const pending = [], uploads = [];
    w.flushAnimationCacheUpload = () => new Promise(resolve => pending.push(resolve));
    context.fetch = async (_url, options) => { uploads.push(JSON.parse(options.body)); return { ok: true }; };
    const upload = uploadFunction(context);
    w._executionCaptureSnapshot = ["first frame"];
    w._executionLightingPromptSnapshot = ["first prompt"];
    const first = upload(node, 1, "first");
    w._executionCaptureSnapshot = ["second frame"];
    w._executionLightingPromptSnapshot = ["second prompt"];
    const second = upload(node, 1, "second");
    pending.forEach(finish => finish(true));
    await Promise.all([first, second]);
    assert.deepEqual(uploads.map(payload => payload.captured_images), [["first frame"], ["second frame"]]);
    assert.deepEqual(uploads.map(payload => payload.lighting_prompts), [["first prompt"], ["second prompt"]]);
});

test("an upload cannot send captures for a replacement workflow after waiting for the animation cache", async () => {
    const { w, node, context } = createScene();
    node.studioWidget = w;
    let finish;
    w.flushAnimationCacheUpload = () => new Promise(resolve => { finish = resolve; });
    context.fetch = () => assert.fail("Stale execution cannot upload replacement captures");
    const upload = uploadFunction(context)(node, 1, "old");
    w._poseDataRestoreToken = (w._poseDataRestoreToken || 0) + 1;
    finish(true);
    await assert.rejects(upload, /scene changed/i);
});
