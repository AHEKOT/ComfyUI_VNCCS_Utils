import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { createScene, Element } from "./helpers/pose_studio_scene.mjs";
import { createDefaultAnimationState, setTrackKeyframeFromEuler } from "../web/pose_studio/animation.mjs";
import { createPoseStudioCharacter } from "../web/pose_studio/characters.mjs";
import { TextToMotionPanel } from "../web/pose_studio/text_to_motion.mjs";

const source = await fs.readFile(new URL("../web/vnccs_pose_studio.js", import.meta.url), "utf8");
const core = await fs.readFile(new URL("../web/pose_studio/core.js", import.meta.url), "utf8");
const noop = () => {};

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

test("switching characters closes the motion session before capturing the previous rig", async () => {
    const { w } = animationScene();
    const panel = w.textToMotionPanel = new TextToMotionPanel(w, {
        fetchApi: async () => ({ ok: true, json: async () => ({ models: [] }) }),
    });
    panel.build = () => { panel.root = { remove: noop }; };
    panel.applyModel = noop;
    panel.open();
    const session = panel.session;
    panel.poses = [{ bones: { head: [55, 0, 0] } }, { bones: { head: [75, 0, 0] } }];
    panel.motion = { fps: 12 };
    const capture = w.captureActiveCharacterRuntime;
    w.captureActiveCharacterRuntime = function (options) {
        assert.equal(panel.isOpen(), false);
        return capture.call(this, options);
    };
    await w.selectCharacter("character-2");
    assert.equal(panel.isOpen(), false);
    assert.ok(panel.session > session, "in-flight results lose their session");
    const before = w.animationSnapshot();
    panel.acceptAnimation();
    assert.equal(w.animationSnapshot(), before);
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
