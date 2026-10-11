import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { createScene, Element } from "./helpers/pose_studio_scene.mjs";
import { createDefaultAnimationState, setTrackKeyframeFromEuler } from "../web/pose_studio/animation.mjs";
import { createPoseStudioCharacter } from "../web/pose_studio/characters.mjs";

const source = await fs.readFile(new URL("../web/vnccs_pose_studio.js", import.meta.url), "utf8");
const core = await fs.readFile(new URL("../web/pose_studio/core.js", import.meta.url), "utf8");
const noop = () => {};

for (const ending of ["pointerup", "pointercancel", "lostpointercapture"]) {
    test(`Light Radar ${ending} preserves the last preview and stops hover edits`, () => {
        const { w } = createScene();
        const light = { type: "point", color: "#ffffff", x: 0, y: 0, z: 0 };
        const previews = [];
        let commits = 0;
        w.applyLighting = () => previews.push([light.x, light.z]);
        w.syncToNode = () => commits++;
        const radar = w.createLightRadar(light);
        radar.emit("pointerdown", { clientX: 70, clientY: 70 });
        radar.emit("pointermove", { clientX: 80, clientY: 80 });
        radar.emit("pointermove", { clientX: 90, clientY: 90 });
        assert.equal(previews.length, 3);
        assert.notDeepEqual(previews[1], previews[2], "the newest light position previews before release");
        const latest = [light.x, light.z];
        radar.emit(ending);
        radar.emit("pointermove", { clientX: 120, clientY: 120 });
        radar.emit("pointerup");
        assert.deepEqual([light.x, light.z], latest);
        assert.equal(previews.length, 3);
        assert.equal(commits, 1);
        assert.equal(radar.hasPointerCapture(1), false);
    });
}

function animationScene() {
    const scene = createScene();
    const { w } = scene;
    w.exportParams.editor_mode = "animation";
    w._animationInitialized = true;
    const keyed = () => {
        const state = createDefaultAnimationState({ bones: { head: [0, 0, 0] } });
        setTrackKeyframeFromEuler(state, "head", 2, [10, 0, 0]);
        setTrackKeyframeFromEuler(state, "head", 3, [20, 0, 0]);
        return state;
    };
    w.animationState = keyed();
    w.getActiveCharacter().animationState = w.animationState;
    const other = createPoseStudioCharacter({ id: "character-2", mesh: w.meshParams, poses: [{}] });
    other.animationState = keyed();
    w.characters.push(other);
    w.syncSharedTimelineFromActive();
    w.resetAnimationHistory();
    return scene;
}

const keys = state => Array.from(state.tracks.head.keys, key => key.frame);

test("Settings FPS previews use the gesture baseline for every character and commit once", () => {
    const { w } = animationScene();
    const fpsSetting = { input: new Element("input") };
    const durationSetting = { input: new Element("input") };
    const start = source.indexOf('        for (const [key, setting] of [["fps", fpsSetting]');
    const end = source.indexOf("        refreshEditorSettings();", source.indexOf("        }\n", start));
    vm.runInNewContext(`(function () { ${source.slice(start, end)} }).call(widget)`, {
        widget: w, fpsSetting, durationSetting, refreshEditorSettings: noop,
    });
    fpsSetting.input.value = "1";
    fpsSetting.input.emit("input");
    assert.equal(w.animationState.fps, 1, "visible timing updates before release");
    assert.equal(w._animationUndoStack.length, 0);
    fpsSetting.input.value = "24";
    fpsSetting.input.emit("input");
    for (const character of w.characters) {
        assert.equal(character.animationState.fps, 24);
        assert.deepEqual(keys(character.animationState), [0, 4, 6]);
    }
    fpsSetting.input.emit("change");
    assert.equal(w._animationUndoStack.length, 1);
    w.undoAnimation();
    for (const character of w.characters) assert.deepEqual(keys(character.animationState), [0, 2, 3]);
});

test("Undo and redo restore every character after a lossy shared FPS change", async () => {
    const { w } = animationScene();
    await w.selectCharacter("character-2");
    const before = w.characters.map(character => w.animationSnapshot(character.animationState));
    w.updateAnimationSettings({ fps: 1 });
    const after = w.characters.map(character => w.animationSnapshot(character.animationState));
    w.undoAnimation();
    assert.deepEqual(w.characters.map(character => w.animationSnapshot(character.animationState)), before);
    w.redoAnimation();
    assert.deepEqual(w.characters.map(character => w.animationSnapshot(character.animationState)), after);
});

function libraryScene() {
    const scene = createScene();
    scene.context.URLSearchParams = URLSearchParams;
    scene.document.createElement = tag => {
        const element = new Element(tag);
        element.style.setProperty = noop;
        const fields = new Map();
        element.querySelector = selector => {
            if (!fields.has(selector)) fields.set(selector, scene.document.createElement("div"));
            return fields.get(selector);
        };
        element.setAttribute = (key, value) => { (element.attributes ||= {})[key] = value; };
        element.closest = () => scene.w.container.children.at(-1);
        return element;
    };
    scene.context.ResizeObserver = class {
        constructor() { this.targets = []; }
        observe(element) { this.targets.push(element); }
        disconnect() { this.disconnected = true; }
    };
    scene.w.refreshLibrary = async () => {};
    scene.w.updateLibraryLayoutScale = noop;
    scene.w.updateLibraryInspectorScale = noop;
    return scene;
}

for (const animation of [false, true]) {
    for (const fails of [false, true]) {
        test(`the newest library ${animation ? "video" : "image"} preview survives an older ${fails ? "failure" : "completion"}`, async () => {
            const { w } = libraryScene();
            w.showLibraryModal();
            const pose = { name: "A", repository: "local_user_poses", category: "Standing",
                asset_type: animation ? "animation" : "pose", data: { prompt: "original" } };
            if (animation) pose.data.animation = createDefaultAnimationState();
            await w.renderLibraryInspector(pose);
            let resolveFirst, rejectFirst;
            const first = new Promise((resolve, reject) => { resolveFirst = resolve; rejectFirst = reject; });
            const readPreview = file => file.name === "first" ? first : Promise.resolve("data:latest");
            w.compressLibraryImage = w.readLibraryFileAsDataUrl = readPreview;
            const messages = [];
            w.showMessage = (...args) => messages.push(args);
            const input = w.libraryInspector.querySelector(".vnccs-ps-library-preview-input");
            const preview = w.libraryInspector.querySelector(".vnccs-ps-library-inspector-preview");
            input.value = "first";
            input.files = [{ name: "first" }];
            const older = input.onchange({ target: input });
            input.value = "latest";
            input.files = [{ name: "latest" }];
            await input.onchange({ target: input });
            const latestMarkup = preview.innerHTML;
            if (fails) rejectFirst(new Error("Old preview could not be read"));
            else resolveFirst("data:old");
            await older;
            assert.equal(preview.innerHTML, latestMarkup);
            assert.equal(input.value, "latest");
            assert.deepEqual(messages, []);
            for (const [field, value] of Object.entries({ name: "A", category: "Standing", tags: "", prompt: "edited" })) {
                w.libraryInspector.querySelector(`.vnccs-ps-library-edit-${field}`).value = value;
            }
            let saved;
            w.saveLibraryPoseRecord = async payload => { saved = payload; return {}; };
            await w.libraryInspector.querySelector(".vnccs-ps-library-save-edit").onclick();
            assert.equal(saved.preview, "data:latest", "the saved item keeps the latest selected file");
        });
    }
}

for (const action of ["selection", "close", "reopen", "remove"]) {
    test(`late preview read errors are ignored after library ${action}`, async () => {
        const { w } = libraryScene();
        w.showLibraryModal();
        const pose = { name: "A", repository: "local_user_poses", category: "Standing", data: { bones: {} } };
        await w.renderLibraryInspector(pose);
        let rejectRead;
        w.compressLibraryImage = () => new Promise((_resolve, reject) => { rejectRead = reject; });
        const messages = [];
        w.showMessage = (...args) => messages.push(args);
        const input = w.libraryInspector.querySelector(".vnccs-ps-library-preview-input");
        input.value = "preview";
        input.files = [{}];
        const pending = input.onchange({ target: input });
        if (action === "selection") await w.renderLibraryInspector({ ...pose, name: "B" });
        if (action === "close") w._closeLibraryModal();
        if (action === "reopen") {
            w._closeLibraryModal();
            w.showLibraryModal();
            await w.renderLibraryInspector({ ...pose, name: "B" });
        }
        if (action === "remove") w._disposed = true;
        rejectRead(new Error("Old preview could not be read"));
        await pending;
        assert.deepEqual(messages, []);
        assert.equal(input.value, "preview");
    });
}

test("library preview failures retain the last valid image and saves wait for the selected file", async () => {
    const { w } = libraryScene();
    w.showLibraryModal();
    const pose = { name: "A", repository: "local_user_poses", category: "Standing", data: { bones: {} } };
    await w.renderLibraryInspector(pose);
    const input = w.libraryInspector.querySelector(".vnccs-ps-library-preview-input");
    const preview = w.libraryInspector.querySelector(".vnccs-ps-library-inspector-preview");
    const save = w.libraryInspector.querySelector(".vnccs-ps-library-save-edit");
    for (const [field, value] of Object.entries({ name: "A", category: "Standing", tags: "", prompt: "edited" })) {
        w.libraryInspector.querySelector(`.vnccs-ps-library-edit-${field}`).value = value;
    }
    const saved = [];
    w.saveLibraryPoseRecord = async payload => { saved.push(payload); return {}; };
    w.compressLibraryImage = async () => "data:valid";
    input.files = [{}];
    await input.onchange({ target: input });
    const validMarkup = preview.innerHTML;
    let rejectRead;
    w.compressLibraryImage = () => new Promise((_resolve, reject) => { rejectRead = reject; });
    const messages = [];
    w.showMessage = (...args) => messages.push(args);
    const pending = input.onchange({ target: input });
    assert.equal(save.disabled, true);
    await save.onclick();
    assert.equal(saved.length, 0, "a pending read must not silently save the previous file");
    rejectRead(new Error("Selected preview could not be read"));
    await pending;
    assert.equal(save.disabled, false);
    assert.equal(preview.innerHTML, validMarkup);
    assert.deepEqual(messages, [["Selected preview could not be read", true]]);
    await save.onclick();
    assert.equal(saved[0].preview, "data:valid");
});

test("an older preview completion cannot enable Save while the newest file is still loading", async () => {
    const { w } = libraryScene();
    w.showLibraryModal();
    await w.renderLibraryInspector({ name: "A", repository: "local_user_poses", category: "Standing", data: { bones: {} } });
    const input = w.libraryInspector.querySelector(".vnccs-ps-library-preview-input");
    const save = w.libraryInspector.querySelector(".vnccs-ps-library-save-edit");
    const reads = [];
    w.compressLibraryImage = () => new Promise(resolve => reads.push(resolve));
    input.files = [{}];
    const older = input.onchange({ target: input });
    const latest = input.onchange({ target: input });
    reads[0]("data:old");
    await older;
    assert.equal(save.disabled, true);
    w.saveLibraryPoseRecord = () => assert.fail("Pending previews cannot be saved");
    await save.onclick();
    reads[1]("data:latest");
    await latest;
    assert.equal(save.disabled, false);
    assert.match(w.libraryInspector.querySelector(".vnccs-ps-library-inspector-preview").innerHTML, /data:latest/);
});

test("Pose Library header scales with both node dimensions without resizing the thumbnails", () => {
    const { w } = createScene();
    const properties = new Map();
    let inspectorUpdates = 0;
    w.libraryModal = {
        clientWidth: 1600, clientHeight: 1000,
        style: { setProperty: (key, value) => properties.set(key, value) },
        getBoundingClientRect: () => { throw new Error("Graph zoom must not determine the layout scale"); },
    };
    w.libraryThumbSize = 320;
    w.updateLibraryInspectorScale = () => { inspectorUpdates++; };
    for (const [width, height, expected] of [
        [800, 500, 0.310], [1600, 1000, 0.620], [3200, 2000, 0.868],
        [2400, 500, 0.310], [800, 1500, 0.310], [400, 300, 0.310],
    ]) {
        Object.assign(w.libraryModal, { clientWidth: width, clientHeight: height });
        w.updateLibraryLayoutScale();
        assert.equal(Number(properties.get("--vnccs-ps-library-header-scale")), expected, `${width} x ${height}`);
        assert.equal(w.libraryThumbSize, 320);
    }
    assert.equal(inspectorUpdates, 6);
    const rules = source.slice(source.indexOf("container: pose-library / inline-size"), source.indexOf(".vnccs-ps-library-workspace {"));
    assert.match(rules, /--vnccs-ps-library-ui-scale:\s*var\(--vnccs-ps-library-header-scale\)/);
    assert.doesNotMatch(rules, /--vnccs-ps-library-ui-scale:\s*0\.62/);
    assert.match(rules, /@container pose-library \(max-width: 600px\)/);
    const settingsRule = rules.match(/\.vnccs-pose-studio \.vnccs-ps-library-settings\s*\{([^}]*)\}/)?.[1] || "";
    assert.match(settingsRule, /zoom:\s*max\(0\.55, var\(--vnccs-ps-library-header-scale\)\)/);
    assert.match(settingsRule, /--vnccs-ps-library-ui-scale:\s*1;/, "settings buttons are not scaled twice");
});

test("Pose Library resize feedback uses the newest dimensions on the next animation frame", () => {
    const { w, context, frames } = createScene();
    frames.clear();
    const properties = new Map();
    let onResize;
    context.ResizeObserver = class {
        constructor(callback) { onResize = callback; }
        observe() {}
    };
    w.libraryModal = {
        clientWidth: 1600, clientHeight: 1000,
        style: { setProperty: (key, value) => properties.set(key, value) },
    };
    w.libraryWorkspace = {};
    w.updateLibraryInspectorScale = noop;
    w.startLibraryResizeObserver();
    onResize();
    Object.assign(w.libraryModal, { clientWidth: 800, clientHeight: 500 });
    onResize();
    assert.equal(frames.size, 1, "multiple resize events share one frame");
    const callback = frames.values().next().value;
    frames.clear();
    callback();
    assert.equal(Number(properties.get("--vnccs-ps-library-header-scale")), 0.310);
    assert.equal(w._libraryResizeFrame, null);
});

test("editing a downloaded item saves a local copy while retaining its source identity", async () => {
    const { w } = libraryScene();
    w.showLibraryModal();
    const pose = { name: "A", repository: "artist/poses", category: "Standing", asset_type: "pose",
        data: { bones: { head: [20, 0, 0] }, prompt: "original" } };
    await w.renderLibraryInspector(pose);
    assert.match(w.libraryInspector.innerHTML, /Save Local Copy/);
    for (const [field, value] of Object.entries({ name: "A", category: "Standing", tags: "tag", prompt: "edited" })) {
        w.libraryInspector.querySelector(`.vnccs-ps-library-edit-${field}`).value = value;
    }
    let saved;
    w.saveLibraryPoseRecord = async payload => { saved = payload; return { id: "local copy" }; };
    await w.libraryInspector.querySelector(".vnccs-ps-library-save-edit").onclick();
    assert.equal(saved.repository, "local_user_poses");
    assert.equal(saved.oldRepository, "artist/poses", "the server can copy the source preview");
    assert.equal(saved.oldName, "A");
    assert.equal(saved.pose.prompt, "edited");
    assert.equal(pose.data.prompt, "original");
    let errorMessage;
    w.showMessage = (message, error) => { if (error) errorMessage = message; };
    w.saveLibraryPoseRecord = async () => { throw new Error("A library item with this name already exists"); };
    await w.libraryInspector.querySelector(".vnccs-ps-library-save-edit").onclick();
    assert.match(errorMessage, /already exists/);
    assert.ok(w.libraryModal, "a rejected copy keeps the editor open");
});

for (const { animation, activeTab = 1, missingBasePose = false } of [
    { animation: false }, { animation: true },
    { animation: false, activeTab: 10_000_000_000 },
    { animation: true, missingBasePose: true },
]) {
    test(`editing a scene ${animation ? "animation" : "pose"} prompt survives Apply (tab ${activeTab}, missing base pose ${missingBasePose})`, async () => {
        const { w, context } = libraryScene();
        const clip = createDefaultAnimationState({ prompt: "original", bones: { head: [20, 0, 0] } });
        if (missingBasePose) delete clip.basePose;
        const asset = {
            type: animation ? "pose_animation" : "scene_pose", schema_version: 3,
            active_character_id: "character-2", activeTab,
            prompt: "original", pose_prompts: ["first pose", "original"],
            characters: [
                { id: "character-1", poses: [{ prompt: "other first" }, { prompt: "other second" }], animation: clip },
                { id: "character-2", poses: [{ prompt: "first pose" }, { prompt: "original", bones: { head: [20, 0, 0] } }], animation: clip },
            ],
            ...(animation ? { animation: clip } : {}),
        };
        const pose = { name: "Scene", repository: "local_user_poses", category: "Standing",
            asset_type: animation ? "animation" : "pose", data: asset };
        w.showLibraryModal();
        await w.renderLibraryInspector(pose);
        for (const [field, value] of Object.entries({ name: "Scene", category: "Standing", tags: "", prompt: "edited" })) {
            w.libraryInspector.querySelector(`.vnccs-ps-library-edit-${field}`).value = value;
        }
        let saved;
        w.saveLibraryPoseRecord = async payload => { saved = payload.pose; return { id: "Scene" }; };
        await w.libraryInspector.querySelector(".vnccs-ps-library-save-edit").onclick();
        const poseIndex = activeTab === 1 ? 1 : 0;
        assert.equal(saved.activeTab, poseIndex);
        assert.equal(saved.characters[1].poses[poseIndex].prompt, "edited");
        assert.equal(saved.pose_prompts[poseIndex], "edited");
        assert.equal(saved.pose_prompts.length, 2, "invalid legacy indices must not create sparse arrays");
        assert.equal(saved.characters[0].poses[1].prompt, "other second");
        assert.equal(saved.characters[1].poses[1 - poseIndex].prompt, poseIndex === 1 ? "first pose" : "original");
        assert.equal(asset.characters[1].poses[1].prompt, "original", "editing must not mutate the cached response");
        if (animation) assert.equal(saved.characters[1].animation.basePose.prompt, "edited");
        context.fetch = async () => ({ ok: true, json: async () => ({ pose: saved, asset_type: pose.asset_type }) });
        w.hydrateCharacterSceneModels = async () => true;
        w.setInterfaceMode = noop;
        await w.loadFromLibrary(pose);
        assert.equal(w.getPosePrompt(), "edited");
        if (animation) assert.equal(w.animationState.basePose.prompt, "edited");
    });
}

test("Apply closes the library through cleanup and reopening observes the new workspace", async () => {
    const { w } = libraryScene();
    w.showLibraryModal();
    const observer = w.libraryResizeObserver;
    const workspace = w.libraryWorkspace;
    const pose = { name: "A", repository: "local_user_poses", category: "Standing", data: { prompt: "pose" } };
    await w.renderLibraryInspector(pose);
    w.loadFromLibrary = async () => {};
    await w.libraryInspector.querySelector(".vnccs-ps-library-apply").onclick();
    assert.equal(observer.disconnected, true);
    assert.equal(w.libraryResizeObserver, null);
    assert.equal(w.libraryModal, null);
    assert.equal(w.libraryInspector, null);
    w.showLibraryModal();
    assert.notEqual(w.libraryWorkspace, workspace);
    assert.ok(w.libraryResizeObserver.targets.includes(w.libraryWorkspace));
    await w.renderLibraryInspector(pose);
    let complete;
    w.loadFromLibrary = () => new Promise(resolve => { complete = resolve; });
    const applying = w.libraryInspector.querySelector(".vnccs-ps-library-apply").onclick();
    w.showLibraryModal();
    const newestObserver = w.libraryResizeObserver;
    complete();
    await applying;
    assert.equal(w.libraryResizeObserver, newestObserver, "an older Apply cannot close a newly opened library");
    assert.equal(newestObserver.disconnected, undefined);
});

test("library cards support keyboard selection and expose their selected state", () => {
    const { w } = libraryScene();
    w.showLibraryModal();
    w.libraryPoses = [{ name: "A", repository: "local_user_poses", category: "Standing", data: {} }];
    w.renderLibraryInspector = noop;
    w.renderLibrary();
    const card = w.libraryGrid.children[0].children[0];
    assert.equal(card.tabIndex, 0);
    assert.equal(card.attributes.role, "button");
    assert.equal(card.attributes["aria-pressed"], "false");
    w.libraryGrid.querySelectorAll = () => [card];
    let selected;
    const select = w.selectLibraryPose;
    w.selectLibraryPose = pose => { selected = pose; select.call(w, pose); };
    for (const key of ["Enter", " "]) {
        selected = null;
        card.emit("keydown", { key });
        assert.equal(selected, w.libraryPoses[0]);
        assert.equal(card.attributes["aria-pressed"], "true");
    }
});

for (const type of ["pointercancel", "lostpointercapture"]) {
    test(`${type} ends direct IK once and subsequent hover cannot keep solving`, () => {
        const { viewer, THREE } = createScene();
        const start = core.indexOf("        // Events\n");
        const end = core.indexOf("        this.hoveredBoneName = null;", start);
        vm.runInNewContext(`(function () { ${core.slice(start, end)} }).call(viewer)`, { viewer });
        viewer.transform = { detach: noop, dragging: false };
        viewer.boneList = [];
        viewer._getRaycastableJointMarkers = () => [];
        viewer.updateMarkers = noop;
        viewer.deselectBone = () => false;
        let solves = 0, ends = 0;
        viewer.solveIKForEffector = () => solves++;
        viewer.options.onInteractionEnd = () => ends++;
        viewer.dispatchPoseChange = noop;
        viewer.orbit.enabled = false;
        viewer.isInteractionActive = true;
        viewer.directDrag = { active: true, hasDragged: true, effector: { position: new THREE.Vector3() },
            plane: new THREE.Plane(new THREE.Vector3(0, 0, 1), 0), offset: new THREE.Vector3() };
        viewer.canvas.setPointerCapture(1);
        viewer.canvas.emit(type);
        assert.equal(viewer.directDrag.active, false);
        assert.equal(ends, 1);
        viewer.canvas.emit("pointerup");
        viewer.handlePointerMove({ buttons: 0, clientX: 70, clientY: 70 });
        assert.equal(viewer.directDrag.active, false);
        assert.equal(viewer.orbit.enabled, true);
        assert.equal(viewer.isInteractionActive, false);
        assert.equal(viewer.canvas.hasPointerCapture(1), false);
        assert.equal(solves, 0);
        assert.equal(ends, 1);
    });
}
