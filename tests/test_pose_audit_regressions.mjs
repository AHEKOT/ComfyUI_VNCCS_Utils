import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { createScene, Element } from "./helpers/pose_studio_scene.mjs";
import {
    createAnimationCacheReference, createDefaultAnimationState,
    evaluateAnimationFrame, setTrackKeyframeFromEuler,
} from "../web/pose_studio/animation.mjs";

const source = await fs.readFile(new URL("../web/vnccs_pose_studio.js", import.meta.url), "utf8");
const noop = () => {};
const angle = state => evaluateAnimationFrame(state, 0).bones.head[0];
function animation(degrees) {
    const state = createDefaultAnimationState({ bones: { head: [0, 0, 0] } });
    setTrackKeyframeFromEuler(state, "head", 0, [degrees, 0, 0]);
    return state;
}
function importJSON(s, data) {
    let reader;
    s.context.FileReader = class { constructor() { reader = this; } readAsText() {} };
    s.w.handleFileImport({ target: { files: [{ name: "pose.json", type: "application/json" }], value: "" } });
    return reader.onload({ target: { result: JSON.stringify(data) } });
}
function useAnimation(s, degrees = 10) {
    s.w.exportParams.editor_mode = "animation";
    s.w._animationInitialized = true;
    s.w.animationState = animation(degrees);
    s.w.getActiveCharacter().animationState = s.w.animationState;
    s.w.captureAnimationEdits = noop;
}
const sync = w => w.syncToNode(false, { skipCapture: true, skipCaptureUpload: true });

test("editing animation preserves the keys referenced by an older saved workflow", async () => {
    const s = createScene(), stored = new Map();
    useAnimation(s);
    s.context.fetch = async (url, options) => {
        if (options?.method === "POST") {
            const payload = JSON.parse(options.body);
            stored.set(payload.animation_id, payload);
            return { ok: true };
        }
        return { ok: true, json: async () => stored.get(url.split("/").at(-1)) };
    };
    sync(s.w);
    const oldReference = JSON.parse(s.node.widgets[0].value).animation;
    assert.equal(await s.w.flushAnimationCacheUpload(), true);
    setTrackKeyframeFromEuler(s.w.animationState, "head", 0, [90, 0, 0]);
    sync(s.w);
    const newReference = JSON.parse(s.node.widgets[0].value).animation;
    assert.notEqual(oldReference.cacheId, newReference.cacheId);
    assert.equal(await s.w.flushAnimationCacheUpload(), true);
    sync(s.w);
    assert.equal(JSON.parse(s.node.widgets[0].value).animation.cacheId, newReference.cacheId);
    assert.equal(await s.w.restoreAnimationFromCache(oldReference), true);
    assert.ok(Math.abs(angle(s.w.animationState) - 10) < 0.01);
    assert.ok(Math.abs(angle(stored.get(newReference.cacheId).animation) - 90) < 0.01);
});

test("queued animation uploads keep the payload from each saved snapshot", async () => {
    const s = createScene(), uploads = [];
    useAnimation(s);
    let releaseFirst;
    s.context.fetch = async (_url, options) => {
        uploads.push(JSON.parse(options.body));
        if (uploads.length === 1) await new Promise(resolve => { releaseFirst = resolve; });
        return { ok: true };
    };
    sync(s.w);
    const first = s.w.flushAnimationCacheUpload();
    setTrackKeyframeFromEuler(s.w.animationState, "head", 0, [20, 0, 0]);
    sync(s.w);
    const second = s.w.flushAnimationCacheUpload();
    setTrackKeyframeFromEuler(s.w.animationState, "head", 0, [30, 0, 0]);
    sync(s.w);
    const third = s.w.flushAnimationCacheUpload();
    releaseFirst();
    assert.deepEqual(await Promise.all([first, second, third]), [true, true, true]);
    assert.deepEqual(uploads.map(payload => Math.round(angle(payload.animation))), [10, 20, 30]);
    assert.equal(new Set(uploads.map(payload => payload.animation_id)).size, 3);
});

for (const pending of [false, true]) {
    test(`JSON animation replaces ${pending ? "pending" : "deferred"} old cache restoration`, async () => {
        const s = createScene({ skinned: true });
        s.w.showMessage = noop;
        const reference = createAnimationCacheReference(animation(10), {
            cacheId: `${s.w.animationCacheNodePrefix()}old`, revision: 1,
        });
        let finish, oldRestore;
        if (pending) {
            s.context.fetch = () => new Promise(resolve => { finish = resolve; });
            oldRestore = s.w._animationCacheRestorePromise = s.w.restoreAnimationFromCache(reference);
        } else s.w._deferredAnimationReference = reference;
        await importJSON(s, { type: "pose_animation", animation: animation(90) });
        if (pending) {
            finish({ ok: true, json: async () => ({ revision: 1, animation: animation(10) }) });
            assert.equal(await oldRestore, false);
        }
        assert.equal(s.w._deferredAnimationReference, null);
        assert.equal(s.w._animationCacheRestorePending, false);
        assert.ok(Math.abs(angle(s.w.animationState) - 90) < 0.01);
    });
}

test("sampled FBX/video poses replace a deferred animation reference", () => {
    const s = createScene({ skinned: true });
    s.w._deferredAnimationReference = { cacheId: "old", storage: "server_cache" };
    s.w.replaceAnimationFromPoses([
        { bones: { head: [30, 0, 0] } }, { bones: { head: [60, 0, 0] } },
    ]);
    assert.equal(s.w._deferredAnimationReference, null);
    assert.ok(Math.abs(angle(s.w.animationState) - 30) < 0.01);
});

test("SAM animation execution uploads freshly captured frames", async () => {
    const s = createScene(), handlers = new Map(), uploads = [];
    useAnimation(s);
    s.context.api = { addEventListener: (name, handler) => handlers.set(name, handler) };
    s.context.app.graph.getNodeById = () => s.node;
    s.context.fetch = async (_url, options) => {
        uploads.push(JSON.parse(options.body)); return { ok: true };
    };
    s.node.studioWidget = s.w;
    for (const method of ["awaitReadyForCompositeCapture", "ensureDebugLibraryReady", "refreshSAMMeshOverlay"]) s.w[method] = async () => {};
    for (const method of ["syncMeshProportionSlidersFromViewer", "applySAM3DFrameCameraParams"]) s.w[method] = noop;
    s.w.prepareSAM3DRenderFit = async () => null;
    s.w.flushAnimationCacheUpload = async () => true;
    s.viewer.applySAM3DImport = () => true;
    let count = 0;
    s.viewer.capture = () => `frame-${count++}`;
    const start = source.indexOf("const waitForPoseStudioSyncIdle =");
    vm.runInNewContext(source.slice(start, source.indexOf("\n    },\n\n    async beforeRegisterNodeDef", start)), s.context);
    await handlers.get("vnccs_apply_sam3d_pose")({ detail: {
        node_id: 1, sync_token: "current", pose_data: {}, apply_mode: "pose",
    } });
    const payload = uploads.find(entry => entry.node_id === "1_current");
    assert.equal(payload.sync_error, undefined);
    assert.equal(count, s.w.animationState.frameCount);
    assert.equal(payload.captured_images.length, count);
    assert.equal(payload.captured_images.at(-1), `frame-${count - 1}`);
});

for (const action of ["character", "tab", "edit", "remove"]) {
    test(`SAM JSON import cannot apply after ${action}`, async () => {
        const s = createScene();
        let finish, applied = 0;
        s.w.prepareSAM3DRenderFit = () => new Promise(resolve => { finish = resolve; });
        s.viewer.applySAM3DImport = () => { applied++; return true; };
        s.w.showMessage = () => assert.fail("Stale imports must not show success or errors");
        const pending = importJSON(s, { body_pose_params: [], keypoints_3d: [], global_rot: [] });
        if (action === "character") s.w.activeCharacterId = "character-2";
        if (action === "tab") s.w.activeTab++;
        if (action === "edit") s.w._libraryLoadToken++;
        if (action === "remove") s.w._disposed = true;
        finish(null);
        await pending;
        assert.equal(applied, 0);
    });
}

test("SAM image import and overlay discard late responses for another character", async () => {
    const s = createScene();
    let finish, applied = 0, closed = 0;
    s.w.showImportProgressModal = () => ({ setProgress: noop, setText: noop, update: noop, close: () => closed++ });
    s.context.setInterval = () => 1; s.context.clearInterval = noop;
    s.w.requestSAM3DPoseForImage = () => new Promise(resolve => { finish = resolve; });
    s.viewer.applySAM3DImport = () => { applied++; return true; };
    const pending = s.w.importSAM3DImageAsPose({ name: "source.png" });
    s.w.activeCharacterId = "character-2";
    finish({});
    await pending;
    assert.equal(applied, 0); assert.equal(closed, 1);
    s.w.exportParams.debugShowSAMHelper = true;
    s.viewer.setSAMMeshOverlayData = () => { applied++; return true; };
    s.w.fetchSAM3DRenderMesh = () => new Promise(resolve => { finish = resolve; });
    const overlay = s.w.refreshSAMMeshOverlay({});
    s.w._libraryLoadToken++;
    finish({});
    assert.equal(await overlay, false); assert.equal(applied, 0);
});

for (const stage of ["modules", "file"]) {
    test(`FBX import stops before retargeting when stale after loading ${stage}`, async () => {
        const mixamo = await fs.readFile(new URL("../web/pose_studio/imports/mixamo.js", import.meta.url), "utf8");
        const start = mixamo.indexOf("export async function importMixamoFBXAnimation");
        const end = mixamo.indexOf("export const importMixamoFBXAsPoses", start);
        let current = true, finish, revoked = 0, loaded = 0, ready;
        const loading = new Promise(resolve => { ready = resolve; });
        const modules = { THREE: {}, FBXLoader: class {
            loadAsync() { loaded++; return new Promise(resolve => { finish = resolve; ready(); }); }
        } };
        const context = {
            loadMixamoModules: () => stage === "modules"
                ? new Promise(resolve => { finish = resolve; ready(); }) : Promise.resolve(modules),
            URL: { createObjectURL: () => "blob:test", revokeObjectURL: () => revoked++ },
        };
        const importFBX = vm.runInNewContext(mixamo.slice(start, end).replace("export async", "async") + "\nimportMixamoFBXAnimation", context);
        const pending = importFBX({}, { isInitialized: () => true, THREE: {} }, { isCurrent: () => current });
        await loading;
        current = false;
        finish(stage === "modules" ? modules : {});
        assert.equal(await pending, null);
        assert.equal(loaded, stage === "modules" ? 0 : 1);
        assert.equal(revoked, stage === "modules" ? 0 : 1);
    });
}

test("active and passive skeleton resources are freed on replacement and removal", () => {
    for (const action of ["replace", "remove"]) {
        const { viewer } = createScene({ skinned: true });
        viewer.orbit.dispose = noop;
        const passive = viewer._cloneActiveRigForPassiveCharacter("passive");
        viewer.passiveCharacters.set("passive", passive);
        viewer.skeleton.computeBoneTexture(); passive.skeleton.computeBoneTexture();
        let texture = 0, passiveTexture = 0, helperGeometry = 0, helperMaterial = 0;
        viewer.skeleton.boneTexture.addEventListener("dispose", () => texture++);
        passive.skeleton.boneTexture.addEventListener("dispose", () => passiveTexture++);
        viewer.skeletonHelper.geometry.addEventListener("dispose", () => helperGeometry++);
        viewer.skeletonHelper.material.addEventListener("dispose", () => helperMaterial++);
        if (action === "replace") {
            viewer._cleanupPrevious(); viewer.removePassiveCharacter("passive");
        } else viewer.dispose();
        assert.deepEqual([texture, passiveTexture, helperGeometry, helperMaterial], [1, 1, 1, 1]);
    }
});

test("ordinary library refreshes fetch metadata; Debug explicitly fetches complete poses", async () => {
    const s = createScene(), urls = [];
    s.context.fetch = async url => {
        urls.push(url);
        return { json: async () => ({ poses: url.endsWith("true") ? [{ name: "A", data: { bones: {} } }] : [] }) };
    };
    s.w.renderLibrary = noop;
    await s.w.refreshLibrary(false);
    s.w.exportParams.debugMode = true;
    await s.w.ensureDebugLibraryReady();
    assert.deepEqual(urls, ["/vnccs/pose_library/list?full=false", "/vnccs/pose_library/list?full=true"]);
});

test("library inspector loads one item and ignores an older selection", async () => {
    const s = createScene(), requests = [];
    s.context.URLSearchParams = URLSearchParams;
    const inspector = s.w.libraryInspector = new Element();
    const fields = new Map();
    inspector.querySelector = key => {
        if (!fields.has(key)) fields.set(key, new Element());
        return fields.get(key);
    };
    s.w.updateLibraryInspectorScale = noop;
    s.context.fetch = url => new Promise(resolve => requests.push({ url, resolve }));
    const a = { name: "A", repository: "local_user_poses", category: "Standing", asset_type: "pose" };
    const b = { ...a, name: "B" };
    const first = s.w.renderLibraryInspector(a);
    assert.equal(inspector.textContent, "Loading library item...");
    const second = s.w.renderLibraryInspector(b);
    assert.match(requests[1].url, /\/get\/B\?/);
    const data = { bones: { head: [20, 0, 0] }, prompt: "selected pose" };
    requests[1].resolve({ ok: true, json: async () => ({ pose: data }) });
    await second;
    assert.equal(b.data, data);
    const selectedMarkup = inspector.innerHTML;
    requests[0].resolve({ ok: true, json: async () => ({ pose: { prompt: "old pose" } }) });
    await first;
    assert.equal(inspector.innerHTML, selectedMarkup);
    assert.equal(a.data, undefined);
    assert.match(inspector.innerHTML, /selected pose/);
    await s.w.renderLibraryInspector(b);
    assert.equal(requests.length, 2);
    inspector.querySelector(".vnccs-ps-library-edit-name").value = "B";
    inspector.querySelector(".vnccs-ps-library-edit-category").value = "Standing";
    inspector.querySelector(".vnccs-ps-library-edit-tags").value = "tag";
    inspector.querySelector(".vnccs-ps-library-edit-prompt").value = "edited";
    let saved;
    s.w.saveLibraryPoseRecord = async payload => { saved = payload; return { id: "B" }; };
    s.w.refreshLibrary = async () => {};
    await inspector.querySelector(".vnccs-ps-library-save-edit").onclick();
    assert.equal(saved.pose.prompt, "edited");
    assert.deepEqual(Array.from(saved.pose.bones.head), [20, 0, 0]);
});

test("Background intentionally changes export state while the Studio viewport stays fixed", () => {
    const { w, viewer, frames } = createScene();
    const background = viewer.scene.background.getHex();
    const field = w.createColorField("Background", "bg_color");
    const input = field.children[1];
    input.value = "#ff0000"; frames.clear(); input.emit("input");
    assert.deepEqual(Array.from(w.exportParams.bg_color), [255, 0, 0]);
    assert.equal(viewer.scene.background.getHex(), background);
    assert.equal(frames.size, 0);
});
