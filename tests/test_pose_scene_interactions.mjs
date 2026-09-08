import assert from "node:assert/strict";
import test from "node:test";
import { createScene } from "./helpers/pose_studio_scene.mjs";

const close = (a, b, message = "") => assert.ok(Math.abs(a - b) < 1e-6, `${message}: ${a} vs ${b}`);
function coherent(scene) {
    const { w, viewer, node } = scene;
    const current = w.currentCameraParams(), active = w.getActiveCharacter();
    for (const [axis, key] of [["x", "offset_x"], ["y", "offset_y"], ["zoom", "zoom"]]) {
        close(active.transform[axis], current[key], `character ${axis}`);
        close(viewer.activeCharacterAppearance.transform[axis], current[key], `appearance ${axis}`);
        close(w.poses[w.activeTab].cameraParams[key], current[key], `pose ${axis}`);

    }
    close(Number(w.exportWidgets.cam_zoom.value), current.zoom, "zoom control");
    assert.equal(w.exportWidgets.cam_offset_x, undefined);
    assert.equal(w.exportWidgets.cam_offset_y, undefined);
    close(viewer.skinnedMesh.scale.x, current.zoom, "actual mesh scale");
    close(viewer.skinnedMesh.position.y, current.offset_y, "actual mesh position");
    const saved = JSON.parse(node.widgets[0].value).characters.find(item => item.id === active.id);
    close(saved.transform.zoom, current.zoom, "serialized zoom");
    close(saved.poses[w.activeTab].cameraParams.offset_y, current.offset_y, "serialized position");
}
function zoom(scene, value) {
    const slider = scene.w.exportWidgets.cam_zoom;
    slider.emit("pointerdown"); slider.value = String(value); slider.emit("input"); slider.emit("pointerup"); slider.emit("change");
}

test("Reset at portrait zoom updates actual mesh, every state mirror, and Preview without a drag", () => {
    const scene = createScene();
    zoom(scene, 6.24);
    scene.w.resetCurrentPose();
    coherent(scene);
    const before = scene.projection();
    assert.ok(before.minY >= -1 && before.maxY <= 1);
    scene.w.applyCameraToViewer(true);
    scene.w.updateCharacterScene();
    coherent(scene);
    assert.deepEqual(scene.projection(), before);
});

test("Age auto-fit stays centered and synchronizes zoom for all ages and aspect ratios", () => {
    const scene = createScene();
    for (const [width, height] of [[1024, 1024], [512, 1536], [1536, 512]]) {
        scene.w.exportParams.view_width = width; scene.w.exportParams.view_height = height;
        for (const age of [1, 8, 25, 61, 90]) {
            zoom(scene, 6.24);
            scene.morph({ age });
            scene.w.applyAgeCameraFit();
            scene.w.syncToNode(false);
            coherent(scene);
            const bounds = scene.projection();
            assert.ok(bounds.minY >= -1.05 && bounds.maxY <= 1.05, `${age}: ${JSON.stringify(bounds)}`);
            assert.ok(bounds.minX >= -1.05 && bounds.maxX <= 1.05, `${age}: ${JSON.stringify(bounds)}`);
        }
    }
});

test("Undo and Redo after Reset restore the actual placement and serialized pose", () => {
    const scene = createScene(); zoom(scene, 5.45);
    scene.w.exportParams.cam_offset_y = -40; scene.w.persistActivePoseCameraParams(); scene.w.syncToNode();
    const before = scene.projection();
    scene.w.resetCurrentPose();
    const reset = scene.projection();
    scene.viewer.undo(); coherent(scene); assert.deepEqual(scene.projection(), before);
    scene.viewer.redo(); coherent(scene); assert.deepEqual(scene.projection(), reset);
});

test("failed auto-fit restores the previous visible model", () => {
    const scene = createScene(); zoom(scene, 4);
    const original = scene.viewer.computeModelFitFraming;
    scene.viewer.computeModelFitFraming = () => null;
    assert.throws(() => scene.w.applyAgeCameraFit(), /Cannot measure/);
    coherent(scene);
    scene.viewer.computeModelFitFraming = original;
});

test("zoom reset button updates the mesh immediately and is one undoable action", () => {
    const scene = createScene(); zoom(scene, 6.24);
    const field = scene.w.createSliderField("Zoom", "cam_zoom", 0.1, 7, 0.01, 1, scene.w.exportParams, true);
    const resetButton = field.children[0].children[1].children[1];
    const history = scene.viewer.history.length;
    resetButton.emit("click");
    coherent(scene); close(scene.viewer.skinnedMesh.scale.x, 1);
    assert.equal(scene.viewer.history.length, history + 1);
    scene.viewer.undo(); coherent(scene); close(scene.viewer.skinnedMesh.scale.x, 6.24);
});

test("tab changes, copy/paste and deletion preserve actual framing and isolate history", () => {
    const scene = createScene(); zoom(scene, 5.45);
    scene.w.exportParams.cam_offset_y = -40; scene.w.persistActivePoseCameraParams(); scene.w.syncToNode();
    const first = scene.projection(); scene.w.copyPose();
    scene.w.addTab(); zoom(scene, 2); const second = scene.projection();
    scene.w.switchTab(0); coherent(scene); assert.deepEqual(scene.projection(), first);
    assert.equal(scene.viewer.history.length, 0);
    scene.w.switchTab(1); coherent(scene); assert.deepEqual(scene.projection(), second);
    scene.w.pastePose(); coherent(scene); assert.deepEqual(scene.projection(), first);
    scene.viewer.undo(); coherent(scene); assert.deepEqual(scene.projection(), second);
    scene.w.deleteTab(0); coherent(scene); assert.deepEqual(scene.projection(), second);
});

test("background imports keep the current model and only the newest reader result is applied", () => {
    const scene = createScene(), readers = [], loaded = [];
    scene.context.FileReader = class { constructor() { readers.push(this); } readAsDataURL() {} };
    scene.viewer.loadReferenceImage = url => loaded.push(url);
    scene.w.loadModel = () => assert.fail("background edits must not reload the model");
    zoom(scene, 6); const before = scene.projection();
    const event = () => ({ target: { files: [{}], value: "file" } });
    scene.w.handleRefImport(event()); scene.w.handleRefImport(event());
    readers[1].onload({ target: { result: "new" } });
    readers[0].onload({ target: { result: "old" } });
    assert.deepEqual(loaded, ["new"]);
    assert.equal(scene.w.exportParams.background_url, "new");
    assert.deepEqual(scene.projection(), before); coherent(scene);
});

test("background textures ignore late replacement and removal results without hiding the last valid image", () => {
    const scene = createScene(), loads = [];
    scene.viewer.THREE = { ...scene.THREE, TextureLoader: class { load(url, callback) { loads.push(callback); } } };
    const texture = () => ({ disposed: false, dispose() { this.disposed = true; } });
    scene.viewer.loadReferenceImage("first");
    assert.equal(scene.viewer.refPlane.visible, false);
    const first = texture(); loads[0](first);
    scene.viewer.loadReferenceImage("second"); scene.viewer.loadReferenceImage("third");
    assert.equal(scene.viewer.refPlane.material.map, first);
    assert.equal(scene.viewer.refPlane.visible, true);
    const stale = texture(); loads[1](stale); assert.equal(stale.disposed, true);
    const third = texture(); loads[2](third); assert.equal(first.disposed, true);
    assert.equal(scene.viewer.refPlane.material.map, third);
    scene.viewer.loadReferenceImage("removed"); scene.viewer.removeReferenceImage();
    const removed = texture(); loads[3](removed);
    assert.equal(removed.disposed, true); assert.equal(scene.viewer.refPlane, null);
});

test("library results are ignored after changing tabs, including a round trip", async () => {
    const scene = createScene(); let resolve;
    scene.context.fetch = () => new Promise(done => { resolve = done; });
    const pending = scene.w.loadFromLibrary("test");
    scene.w.addTab(); scene.w.switchTab(0);
    zoom(scene, 4); const before = scene.projection();
    resolve({ ok: true, json: async () => ({ pose: { bones: {}, cameraParams: { zoom: 1 } } }) });
    await pending;
    coherent(scene); assert.deepEqual(scene.projection(), before);
});

test("Age fit remains centered after camera yaw and pitch changes", () => {
    const scene = createScene();
    for (const [yaw, pitch] of [[30, 20], [-45, -20], [90, 0], [180, 0]]) {
        scene.w.exportParams.cam_yaw_deg = yaw; scene.w.exportParams.cam_pitch_deg = pitch;
        scene.w.persistActivePoseCameraParams();
        scene.morph({ age: 61 }); scene.w.applyAgeCameraFit(); scene.w.syncToNode();
        coherent(scene);
        const bounds = scene.projection();
        assert.ok(bounds.minY >= -1.05 && bounds.maxY <= 1.05, `${yaw}/${pitch}: ${JSON.stringify(bounds)}`);
        assert.ok(bounds.minX >= -1.05 && bounds.maxX <= 1.05, `${yaw}/${pitch}: ${JSON.stringify(bounds)}`);
    }
});

test("character switching preserves independent portrait framing", async () => {
    const scene = createScene(); zoom(scene, 6);
    scene.w.exportParams.cam_offset_y = -60; scene.w.persistActivePoseCameraParams(); scene.w.syncToNode();
    const first = scene.projection(), firstId = scene.w.activeCharacterId;
    const second = scene.context.createPoseStudioCharacter({ index: 1, mesh: scene.w.meshParams, transform: { x: 2, y: -25, zoom: 3 } });
    scene.w.characters.push(second); scene.w.ensurePoseCameraParams();
    await scene.w.selectCharacter(second.id);
    coherent(scene); close(scene.viewer.skinnedMesh.scale.x, 3);
    const other = scene.projection();
    await scene.w.selectCharacter(firstId);
    coherent(scene); assert.deepEqual(scene.projection(), first);
    await scene.w.selectCharacter(second.id);
    coherent(scene); assert.deepEqual(scene.projection(), other);
});

test("workflow restore preserves portrait placement and Keep Original Lighting", () => {
    const scene = createScene(); zoom(scene, 6.2);
    scene.w.exportParams.cam_offset_y = -41;
    scene.w.exportParams.keepOriginalLighting = true;
    scene.w.persistActivePoseCameraParams(); scene.w.syncToNode();
    const before = scene.projection(), saved = scene.node.widgets[0].value;
    const restored = createScene();
    // Model downloads and application panels are outside the in-memory scene harness.
    restored.w.hydrateCharacterSceneModels = async () => {};
    restored.w.setInterfaceMode = () => {};
    restored.viewer.setSkinMode = () => {};
    restored.context.console = { ...console, error: (...args) => assert.fail(args.join(" ")) };
    restored.node.widgets[0].value = saved;
    restored.w.loadFromNode(); restored.w.syncToNode();
    coherent(restored); assert.deepEqual(restored.projection(), before);
    assert.equal(restored.viewer.scene.background.getHex(), 0x1a1a2e);
    assert.equal(restored.viewer.lights.length, 1);
    assert.equal(restored.viewer.lights[0].isAmbientLight, true);
    close(restored.viewer.lights[0].intensity, 1);
    restored.w.exportParams.keepOriginalLighting = false; restored.w.applyLighting();
    assert.ok(restored.viewer.lights.some(light => light.isDirectionalLight));
});

test("single-pose JSON export and import retain the actual portrait framing", async () => {
    const scene = createScene(); zoom(scene, 6.2);
    scene.w.exportParams.cam_offset_y = -41; scene.w.persistActivePoseCameraParams(); scene.w.syncToNode();
    const before = scene.projection(); let blob, reader;
    scene.context.URL = { createObjectURL: value => { blob = value; return "blob:export"; }, revokeObjectURL() {} };
    scene.context.FileReader = class { constructor() { reader = this; } readAsText() {} };
    scene.context.console = { ...console, error: (...args) => assert.fail(args.join(" ")) };
    scene.w.exportPose("single", "portrait");
    const json = await blob.text();
    zoom(scene, 1);
    scene.w.handleFileImport({ target: { files: [{ name: "portrait.json", type: "application/json" }] } });
    await reader.onload({ target: { result: json } });
    coherent(scene); assert.deepEqual(scene.projection(), before);
});

test("export background color leaves the editor dark while light color updates live", () => {
    const scene = createScene();
    const field = scene.w.createColorField("Background", "bg_color");
    const color = field.children[1]; color.value = "#8033ff"; color.emit("input");
    assert.equal(scene.viewer.scene.background.getHex(), 0x1a1a2e);
    assert.deepEqual(Array.from(scene.w.exportParams.bg_color), [128, 51, 255]);
    scene.w.lightListContainer = new scene.w.container.constructor();
    scene.w.refreshLightUI();
    const find = root => root.children.flatMap(child => [child, ...find(child)]);
    const lightColor = find(scene.w.lightListContainer).find(child => child.type === "color");
    lightColor.value = "#12ff34"; lightColor.emit("input");
    assert.equal(scene.viewer.lights[0].color.getHexString(), "12ff34");
});

test("animation Reset restores mesh proportions together with the clip in one Undo", () => {
    const scene = createScene();
    scene.w.ensureAnimationInitialized(); scene.w.exportParams.editor_mode = "animation";
    scene.w.meshParams.head_size = 1.4; scene.w.applyCurrentMeshProportions(); scene.w.syncToNode();
    const before = scene.w._animationUndoStack.length;
    scene.w.resetCurrentPose();
    close(scene.w.meshParams.head_size, 1);
    assert.equal(scene.w._animationUndoStack.length, before + 1);
    scene.w.undoAnimation(); close(scene.w.meshParams.head_size, 1.4);
    assert.equal(JSON.parse(scene.node.widgets[0].value).characters[0].mesh.head_size, 1.4);
    scene.w.redoAnimation(); close(scene.w.meshParams.head_size, 1);
});

test("a delayed Age fit is part of the same animation gesture", () => {
    const scene = createScene(); zoom(scene, 6);
    scene.w.ensureAnimationInitialized(); scene.w.exportParams.editor_mode = "animation";
    scene.w.resetAnimationHistory();
    scene.w.requestLiveMorph = () => true;
    scene.w.createSliderField("Age", "age", 1, 90, 1, 25, scene.w.meshParams);
    const slider = scene.w.sliders.age.slider;
    slider.emit("pointerdown");
    for (const age of [30, 40, 61]) { slider.value = String(age); slider.emit("input"); }
    slider.emit("pointerup"); slider.emit("change");
    assert.equal(scene.w._animationUndoStack.length, 0);
    scene.morph(); scene.w.pendingAgeCameraFit = false;
    scene.w.applyAgeCameraFit(); scene.w.syncToNode();
    assert.equal(scene.w._animationUndoStack.length, 1);
    scene.w.undoAnimation(); close(scene.viewer.skinnedMesh.scale.x, 6);
    assert.equal(scene.w._animationUndoStack.length, 0);
    scene.w.redoAnimation(); close(scene.w.meshParams.age, 61);
});

test("position UI retains the existing pad and buttons without added input fields", () => {
    const { pad } = createScene();
    assert.deepEqual(pad.parentElement.children.map(child => child.tagName), ["CANVAS", "BUTTON", "BUTTON"]);
});

test("capture applies the export background only while rendering the output", () => {
    const scene = createScene(), rendered = [];
    scene.viewer.renderer = {
        getSize: target => target.set(640, 480), getPixelRatio: () => 1,
        setPixelRatio() {}, setSize() {},
        render: (world, camera) => rendered.push({ color: world.background.clone(), camera }),
    };
    scene.viewer.canvas.toDataURL = () => "data:image/png;base64,test";
    const result = scene.viewer.capture(512, 512, 1, [255, 255, 255]);
    assert.equal(result, "data:image/png;base64,test");
    assert.equal(rendered[0].color.getHex(), 0xffffff);
    assert.equal(rendered[0].camera, scene.viewer.captureCamera);
    assert.equal(rendered.at(-1).color.getHex(), 0x1a1a2e);
    assert.equal(rendered.at(-1).camera, scene.viewer.camera);
    assert.equal(scene.viewer.scene.background.getHex(), 0x1a1a2e);
});

test("Re-center centers visible geometry after Age without changing model zoom", () => {
    const scene = createScene();
    const recenter = scene.pad.parentElement.children.find(child => child.tagName === "BUTTON");
    for (const age of [25, 1, 61, 8]) {
        scene.morph({ age });
        scene.w.applyAgeCameraFit();
        for (const value of [1.47, 3.51, 7]) {
            zoom(scene, value);
            scene.w.exportParams.cam_offset_x = 4;
            scene.w.exportParams.cam_offset_y = -8;
            scene.w.persistActivePoseCameraParams();
            recenter.click();
            const bounds = scene.projection();
            close((bounds.minX + bounds.maxX) / 2, 0);
            close((bounds.minY + bounds.maxY) / 2, 0);
            close(scene.viewer.skinnedMesh.scale.x, value);
            scene.pad.drawCommands.length = 0;
            scene.w.radarRedraw();
            const dot = scene.pad.drawCommands.find(command => command.method === "arc");
            assert.ok(dot.args.slice(0, 2).every(Number.isFinite));
            coherent(scene);
        }
    }
});

test("Re-center uses camera screen axes at side and elevated angles", () => {
    const scene = createScene();
    const recenter = scene.pad.parentElement.children.find(child => child.tagName === "BUTTON");
    scene.morph({ age: 1 });
    zoom(scene, 3.51);
    for (const [yaw, pitch] of [[90, 0], [-90, 30], [45, -30], [180, 0]]) {
        scene.w.exportParams.cam_yaw_deg = yaw;
        scene.w.exportParams.cam_pitch_deg = pitch;
        scene.w.applyCameraToViewer(true);
        recenter.click();
        const bounds = scene.projection();
        close((bounds.minX + bounds.maxX) / 2, 0);
        close((bounds.minY + bounds.maxY) / 2, 0);
        coherent(scene);
    }
});


test("Re-center measures the rendered MakeHuman triangles after Age", () => {
    const scene = createScene({ skinned: true });
    const recenter = scene.pad.parentElement.children.find(child => child.tagName === "BUTTON");
    for (const age of [25, 1, 61]) {
        scene.morph({ age });
        scene.w.applyAgeCameraFit();
        zoom(scene, 3.56);
        recenter.click();
        scene.w.updateCharacterScene();
        const b = scene.projection();
        close((b.minX + b.maxX) / 2, 0, `age ${age} horizontal center`);
        close((b.minY + b.maxY) / 2, 0, `age ${age} vertical center`);
    }
});

test("pad point and visible model center agree before release and after Re-center", () => {
    const scene = createScene({ skinned: true });
    const recenter = scene.pad.parentElement.children.find(child => child.tagName === "BUTTON");
    const verify = (x, y, halfW, halfH) => {
        const b = scene.projection();
        close((b.minX + b.maxX) / 2, x);
        close((b.minY + b.maxY) / 2, y);
        scene.pad.drawCommands.length = 0;
        scene.w.radarRedraw();
        const dot = scene.pad.drawCommands.find(command => command.method === "arc");
        assert.ok(Math.abs(dot.args[0] - (70 + x * halfW)) < 0.001);
        assert.ok(Math.abs(dot.args[1] - (70 - y * halfH)) < 0.001);
        const frame = scene.pad.drawCommands.find(command => command.method === "strokeRect");
        close(frame.args[2], halfW * 2); close(frame.args[3], halfH * 2);
    };
    for (const age of [25, 1, 61]) {
        scene.morph({ age }); scene.w.applyAgeCameraFit();
        for (const aspect of [1, 0.5, 2]) {
            scene.w.exportParams.view_width = 1024 * aspect;
            scene.w.exportParams.view_height = 1024;
            zoom(scene, 3.54);
            const halfW = 30 * Math.min(1, aspect), halfH = 30 / Math.max(1, aspect);
            recenter.click(); verify(0, 0, halfW, halfH);
            scene.pad.emit("pointerdown", { clientX: 70, clientY: 70 });
            verify(0, 0, halfW, halfH);
            for (const [x, y] of [[-0.5, -0.5], [0.9, 0.9], [1.1, 1.1], [0, 0]]) {
                scene.pad.emit("pointermove", { clientX: 70 + x * halfW, clientY: 70 - y * halfH });
                verify(x, y, halfW, halfH);
            }
            scene.pad.emit("pointerup"); coherent(scene);
            recenter.click(); verify(0, 0, halfW, halfH);
        }
    }
});

test("reload redraws the pad after the first loaded viewport frame without user input", () => {
    const scene = createScene({ skinned: true });
    scene.morph({ age: 1 });
    scene.w.applyAgeCameraFit();
    const bone = scene.viewer.boneList.find(bone => bone.userData.parentName);
    bone.rotation.z = 0.45;
    const savedPose = scene.viewer.getPose();
    const savedMesh = scene.viewer.skinnedMesh;
    scene.viewer.skinnedMesh = null;
    scene.pad.drawCommands.length = 0;
    scene.w.radarRedraw();
    assert.equal(scene.pad.drawCommands.some(command => command.method === "arc"), false);

    scene.viewer.skinnedMesh = savedMesh;
    scene.viewer.setPose(savedPose, true);
    scene.w.applyCameraToViewer(true);
    let rendered = false;
    scene.viewer.renderer = { render: () => { rendered = true; scene.viewer.scene.updateMatrixWorld(true); } };
    scene.viewer._needsRender = true;
    scene.viewer.animate();
    assert.ok(rendered);
    const dot = scene.pad.drawCommands.find(command => command.method === "arc");
    assert.ok(dot, "the first loaded viewport frame must restore the point");
    const b = scene.projection();
    assert.ok(Math.abs(dot.args[0] - (70 + 30 * (b.minX + b.maxX) / 2)) < 0.001);
    assert.ok(Math.abs(dot.args[1] - (70 - 30 * (b.minY + b.maxY) / 2)) < 0.001);
    const draws = scene.pad.drawCommands.length;
    scene.viewer.animate();
    assert.equal(scene.pad.drawCommands.length, draws, "idle frames must not poll or redraw the pad");
});
