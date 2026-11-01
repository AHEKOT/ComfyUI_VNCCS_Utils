import assert from "node:assert/strict";
import test from "node:test";
import { createScene, Element } from "./helpers/pose_studio_scene.mjs";
import {
    computeSubjectSizeDistance,
    normalizeCaptureLens,
    resolveCaptureCameraParams,
} from "../web/pose_studio/animation.mjs";

const noop = () => {};
const tanHalf = degrees => Math.tan(degrees * Math.PI / 360);
const close = (actual, expected, epsilon = 1e-9, message = "") => assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `${message} expected ${expected}, received ${actual}`,
);

function lensScene() {
    const scene = createScene();
    scene.w.hydrateCharacterSceneModels = async () => {};
    scene.w.setInterfaceMode = noop;
    scene.viewer.setSkinMode = noop;
    scene.context.URLSearchParams = URLSearchParams;
    scene.context.fetch = async () => ({ ok: true, json: async () => ({}) });
    scene.messages = [];
    scene.w.showMessage = (message, error) => scene.messages.push({ message, error });
    const section = { content: new Element() };
    scene.w.createCaptureLensControls(section);
    scene.section = section;
    // Every render is recorded with the camera state it actually used.
    scene.renders = [];
    scene.viewer.canvas.toDataURL = () => `data:image/png;base64,${scene.renders.length}`;
    scene.viewer.renderer = {
        render: (_scene, camera) => {
            // The editor viewport repaint after a capture batch is not an output.
            if (camera === scene.viewer.camera) return;
            camera.updateMatrixWorld(true);
            scene.renders.push({
                fov: camera.fov,
                projection: camera.projectionMatrix.toArray(),
                world: camera.matrixWorld.toArray(),
            });
        },
        getSize: target => target.set(512, 512),
        setSize: noop,
        getPixelRatio: () => 1,
        setPixelRatio: noop,
    };
    return scene;
}

function slide(scene, key, value) {
    const slider = scene.w.exportWidgets[key];
    slider.emit("pointerdown");
    slider.value = String(value);
    slider.emit("input");
    slider.emit("change");
    slider.emit("pointerup");
}

function cameraState(viewer) {
    viewer.captureCamera.updateMatrixWorld(true);
    return {
        fov: viewer.captureCamera.fov,
        projection: viewer.captureCamera.projectionMatrix.toArray(),
        world: viewer.captureCamera.matrixWorld.toArray(),
    };
}

function assertSameCamera(actual, expected, message) {
    close(actual.fov, expected.fov, 1e-9, `${message} fov`);
    for (const key of ["projection", "world"]) {
        actual[key].forEach((value, index) => close(value, expected[key][index], 1e-6, `${message} ${key}[${index}]`));
    }
}

function distanceToTarget(viewer) {
    const target = viewer.sceneCameraTarget;
    return viewer.captureCamera.position.distanceTo(target);
}

test("lens normalization keeps the legacy camera and rejects invalid values", () => {
    assert.deepEqual(normalizeCaptureLens(), { fov_deg: 30, distance: 45, maintain_subject_size: false });
    assert.deepEqual(normalizeCaptureLens(null), { fov_deg: 30, distance: 45, maintain_subject_size: false });
    for (const value of [NaN, Infinity, -Infinity, "abc", "", " ", null, undefined, true, {}, []]) {
        assert.deepEqual(
            normalizeCaptureLens({ fov_deg: value, distance: value, maintain_subject_size: value }),
            { fov_deg: 30, distance: 45, maintain_subject_size: value === true },
            String(value),
        );
    }
    assert.deepEqual(normalizeCaptureLens({ fov_deg: 1, distance: 0 }), { fov_deg: 15, distance: 10, maintain_subject_size: false });
    assert.deepEqual(normalizeCaptureLens({ fov_deg: 179, distance: 1e9 }), { fov_deg: 75, distance: 250, maintain_subject_size: false });
    assert.deepEqual(normalizeCaptureLens({ fov_deg: "50", distance: "60", maintain_subject_size: true }), { fov_deg: 50, distance: 60, maintain_subject_size: true });
    assert.deepEqual(
        resolveCaptureCameraParams({ yaw_deg: 10 }, {}),
        { zoom: 1, offset_x: 0, offset_y: 0, yaw_deg: 10, pitch_deg: 0, fov_deg: 30, distance: 45, maintain_subject_size: false },
    );
});

test("subject-size distance follows distance * tan(fov / 2) at the boundaries", () => {
    for (const fov of [15, 20, 30, 45, 60, 75]) {
        close(computeSubjectSizeDistance(45, 30, fov), 45 * tanHalf(30) / tanHalf(fov));
    }
    close(computeSubjectSizeDistance(45, 30, 15), 91.5874, 1e-3);
    close(computeSubjectSizeDistance(45, 30, 75), 15.7137, 1e-3);
    assert.equal(computeSubjectSizeDistance(200, 30, 15), 250, "distance is clamped to the far range");
    assert.equal(computeSubjectSizeDistance(10, 75, 75), 10);
});

test("defaults are FOV 30 and distance 45 on the controls and the capture camera", () => {
    const { w, viewer } = lensScene();
    assert.equal(w.exportParams.cam_fov_deg, 30);
    assert.equal(w.exportParams.cam_distance, 45);
    assert.equal(w.exportParams.cam_maintain_subject_size, false);
    assert.equal(w.exportWidgets.cam_fov_deg.value, 30);
    assert.equal(w.exportWidgets.cam_distance.value, 45);
    assert.equal(viewer.captureCamera.fov, 30);
    close(distanceToTarget(viewer), 45, 1e-9);
    assert.deepEqual(
        { fov: w.currentCameraParams().fov_deg, distance: w.currentCameraParams().distance },
        { fov: 30, distance: 45 },
    );
});

test("FOV and distance update the real perspective projection while sliding", () => {
    const scene = lensScene();
    const { w, viewer } = scene;
    const before = cameraState(viewer);
    const beforeBounds = scene.projection();
    const slider = w.exportWidgets.cam_fov_deg;
    slider.emit("pointerdown");
    slider.value = "60";
    slider.emit("input");
    // Visible during the gesture, before release.
    assert.equal(viewer.captureCamera.fov, 60);
    assert.notDeepEqual(cameraState(viewer).projection, before.projection);
    close(viewer.captureCamera.projectionMatrix.elements[5], 1 / tanHalf(60), 1e-9);
    slider.emit("change"); slider.emit("pointerup");
    const wide = scene.projection();
    assert.ok(wide.maxY - wide.minY < (beforeBounds.maxY - beforeBounds.minY) * 0.6, "distance stays fixed when size is not maintained");
    close(distanceToTarget(viewer), 45, 1e-9);

    slide(scene, "cam_distance", 90);
    close(distanceToTarget(viewer), 90, 1e-9);
    assert.equal(viewer.captureCamera.fov, 60);
    const far = scene.projection();
    assert.ok(far.maxY - far.minY < wide.maxY - wide.minY);

    for (const fov of [15, 75]) {
        slide(scene, "cam_fov_deg", fov);
        const bounds = scene.projection();
        assert.equal(viewer.captureCamera.fov, fov);
        assert.ok(Object.values(bounds).every(Number.isFinite), `${fov}: ${JSON.stringify(bounds)}`);
        assert.ok(bounds.maxY > bounds.minY, "the mannequin is not mirrored behind the camera");
    }
});

test("numeric fields drive the paired sliders and stay synchronized", () => {
    const scene = lensScene();
    const { w, viewer } = scene;
    const input = w.exportWidgets.cam_fov_deg._vnccsNumberInput;
    input.value = "42";
    input.emit("input");
    assert.equal(w.exportParams.cam_fov_deg, 42);
    assert.equal(viewer.captureCamera.fov, 42);
    input.value = "500";
    input.emit("input");
    assert.equal(w.exportParams.cam_fov_deg, 75, "out-of-range input is clamped");
    input.value = "";
    input.emit("input");
    assert.equal(w.exportParams.cam_fov_deg, 75, "empty input is ignored");
    slide(scene, "cam_distance", 60);
    assert.equal(w.exportWidgets.cam_distance._vnccsNumberInput.value, "60");
});

test("Maintain Subject Size dollies the camera without accumulating error", () => {
    const scene = lensScene();
    const { w, viewer } = scene;
    const checkbox = w.exportWidgets.cam_maintain_subject_size;
    checkbox.checked = true; checkbox.emit("change");
    const baseBounds = scene.projection();
    const baseHeight = baseBounds.maxY - baseBounds.minY;
    for (const fov of [75, 15, 60]) {
        slide(scene, "cam_fov_deg", fov);
        close(w.exportParams.cam_distance, 45 * tanHalf(30) / tanHalf(fov), 1e-9, `fov ${fov}`);
        close(distanceToTarget(viewer), w.exportParams.cam_distance, 1e-9);
        const bounds = scene.projection();
        assert.ok(Math.abs((bounds.maxY - bounds.minY) / baseHeight - 1) < 0.12, `${fov}: subject keeps its size`);
    }
    // Many steps and a round trip return exactly to the original distance.
    for (let step = 0; step < 200; step += 1) slide(scene, "cam_fov_deg", 15 + (step * 7) % 61);
    slide(scene, "cam_fov_deg", 30);
    close(w.exportParams.cam_distance, 45, 1e-9);

    // A clamped dolly does not drift either.
    slide(scene, "cam_distance", 200);
    slide(scene, "cam_fov_deg", 15);
    assert.equal(w.exportParams.cam_distance, 250);
    slide(scene, "cam_fov_deg", 30);
    close(w.exportParams.cam_distance, 200, 1e-9);

    checkbox.checked = false; checkbox.emit("change");
    slide(scene, "cam_fov_deg", 50);
    close(w.exportParams.cam_distance, 200, 1e-9, "OFF keeps the distance fixed");
});

test("slider reset and camera reset return to the default lens", () => {
    const scene = lensScene();
    const { w, viewer } = scene;
    slide(scene, "cam_fov_deg", 55);
    slide(scene, "cam_distance", 80);
    const resetButton = node => node.children?.flatMap(child => [child, ...resetButton(child)]) || [];
    const fovReset = resetButton(scene.section.content).find(element => element.tagName === "BUTTON" && element.title === "Reset to 30");
    fovReset.onclick({ stopPropagation: noop });
    assert.equal(w.exportParams.cam_fov_deg, 30);
    assert.equal(viewer.captureCamera.fov, 30);
    w.exportParams.cam_maintain_subject_size = true;
    w.resetCameraParams();
    w.applyCameraToViewer(true);
    assert.deepEqual(
        [w.exportParams.cam_fov_deg, w.exportParams.cam_distance, w.exportParams.cam_maintain_subject_size],
        [30, 45, false],
    );
    close(distanceToTarget(viewer), 45, 1e-9);
});

test("undo and redo restore the lens with one command per gesture", () => {
    const scene = lensScene();
    const { w, viewer } = scene;
    slide(scene, "cam_fov_deg", 62);
    slide(scene, "cam_distance", 70);
    viewer.undo();
    assert.equal(w.exportParams.cam_distance, 45);
    assert.equal(w.exportParams.cam_fov_deg, 62);
    viewer.undo();
    assert.equal(w.exportParams.cam_fov_deg, 30);
    assert.equal(viewer.captureCamera.fov, 30);
    viewer.redo();
    assert.equal(w.exportParams.cam_fov_deg, 62);
    assert.equal(viewer.captureCamera.fov, 62);
});

test("pose tabs keep separate lenses and two characters share each tab's lens", async () => {
    const scene = lensScene();
    const { w, viewer, context } = scene;
    const second = context.createPoseStudioCharacter({ index: 1, mesh: w.meshParams, transform: { x: 6, y: 0, zoom: 1 } });
    w.characters.push(second); w.ensurePoseCameraParams();
    slide(scene, "cam_fov_deg", 50);
    w.addTab();
    assert.equal(w.exportParams.cam_fov_deg, 30, "a new pose tab starts from the default lens");
    slide(scene, "cam_fov_deg", 70);
    slide(scene, "cam_distance", 30);
    for (const character of w.characters) {
        assert.equal(character.poses[0].cameraParams.fov_deg, 50);
        assert.equal(character.poses[1].cameraParams.fov_deg, 70);
        assert.equal(character.poses[1].cameraParams.distance, 30);
    }
    w.switchTab(0);
    assert.equal(w.exportParams.cam_fov_deg, 50);
    assert.equal(w.exportParams.cam_distance, 45);
    assert.equal(viewer.captureCamera.fov, 50);
    await w.selectCharacter(second.id);
    assert.equal(w.exportParams.cam_fov_deg, 50, "switching character keeps the shared scene lens");
    w.switchTab(1);
    assert.equal(viewer.captureCamera.fov, 70);
    close(distanceToTarget(viewer), 30, 1e-9);
});

test("RUN captures render every pose tab with its own lens and restore the active one", () => {
    const scene = lensScene();
    const { w, viewer } = scene;
    slide(scene, "cam_fov_deg", 50);
    w.addTab();
    slide(scene, "cam_fov_deg", 70);
    scene.renders.length = 0;
    w.syncToNode(true, { executionCapture: true, skipCaptureUpload: true });
    assert.deepEqual(scene.renders.map(render => render.fov), [50, 70]);
    assert.equal(viewer.captureCamera.fov, 70, "the active tab's lens is restored after the batch");
    assert.equal(w.poseCaptures.length, 2);
    // A single active capture also uses the active lens.
    w.switchTab(0);
    scene.renders.length = 0;
    w.syncToNode(false, { skipCapture: false, skipCaptureUpload: true });
    assert.deepEqual(scene.renders.map(render => render.fov), [50]);
});

test("Pose Manager cards use each pose's lens and RUN reuses those exact cards", () => {
    const scene = lensScene();
    const { w, viewer } = scene;
    slide(scene, "cam_fov_deg", 20);
    w.addTab();
    slide(scene, "cam_fov_deg", 65);
    w.interfaceMode = "manager";
    w.renderPoseManager = noop;
    w.updatePoseManagerPreviewImage = noop;
    scene.renders.length = 0;
    const generation = w.scheduleAllManagerPreviewRefresh();
    for (const [id, frame] of [...scene.frames]) { scene.frames.delete(id); frame(); }
    assert.equal(w._managerPreviewRefreshCompletedGeneration, generation);
    assert.deepEqual(scene.renders.map(render => render.fov), [20, 65]);
    assert.equal(viewer.captureCamera.fov, 65);
    const cards = w.poseCaptures.slice();
    scene.renders.length = 0;
    w.syncToNode(true, { executionCapture: true, skipCaptureUpload: true });
    assert.equal(scene.renders.length, 0, "RUN must not re-render with another lens");
    assert.deepEqual(w._executionCaptureSnapshot, cards);
});

async function saveLibraryScene(scene) {
    let saved = null;
    scene.w.saveLibraryPoseRecord = async payload => { saved = payload; return { id: payload.name }; };
    scene.w.compressLibraryImage = async value => value;
    scene.w.refreshLibrary = noop;
    assert.equal(await scene.w.saveToLibrary("Lens scene", true), true);
    return saved;
}

async function loadLibraryPose(scene, pose) {
    scene.context.fetch = async () => ({ ok: true, json: async () => ({ pose, asset_type: "pose" }) });
    await scene.w.loadFromLibrary({ name: "Lens scene", repository: "local_user_poses", data: pose });
    assert.deepEqual(scene.messages.filter(item => item.error), []);
}

test("Pose Library round-trips a two-character lens to the same projection in another workflow", async () => {
    const source = lensScene();
    const { w } = source;
    const second = source.context.createPoseStudioCharacter({ index: 1, mesh: w.meshParams, transform: { x: 7, y: -2, zoom: 1.2 } });
    w.characters.push(second); w.ensurePoseCameraParams();
    w.updateCharacterScene();
    slide(source, "cam_yaw_deg", 25);
    slide(source, "cam_pitch_deg", -10);
    w.exportWidgets.cam_maintain_subject_size.checked = true;
    w.exportWidgets.cam_maintain_subject_size.emit("change");
    slide(source, "cam_fov_deg", 62);
    w.exportParams.cam_offset_x = 3; w.exportParams.cam_zoom = 1.4;
    w.persistActivePoseCameraParams(); w.applyCameraToViewer(true);
    const expected = cameraState(source.viewer);
    const expectedBounds = source.projection();
    source.renders.length = 0;
    const record = await saveLibraryScene(source);
    assert.equal(source.renders.length, 1, "the library preview is rendered");
    assertSameCamera(source.renders[0], expected, "library preview");

    const saved = JSON.parse(JSON.stringify(record.pose));
    assert.equal(saved.characters.length, 2);
    for (const target of [saved.camera, saved.cameraParams, ...saved.characters.map(character => character.poses[0].cameraParams)]) {
        assert.equal(target.fov_deg, 62);
        close(target.distance, 45 * tanHalf(30) / tanHalf(62));
        assert.equal(target.maintain_subject_size, true);
        assert.equal(target.yaw_deg, 25);
        assert.equal(target.pitch_deg, -10);
    }

    // Another workflow, with a different lens already applied.
    const target = lensScene();
    const targetSecond = target.context.createPoseStudioCharacter({ index: 1, mesh: target.w.meshParams });
    target.w.characters.push(targetSecond); target.w.ensurePoseCameraParams();
    slide(target, "cam_fov_deg", 18);
    slide(target, "cam_distance", 120);
    await loadLibraryPose(target, saved);
    assertSameCamera(cameraState(target.viewer), expected, "restored capture camera");
    assert.deepEqual(target.projection(), expectedBounds);
    assert.equal(target.w.exportWidgets.cam_fov_deg.value, 62);
    close(Number(target.w.exportWidgets.cam_distance.value), saved.camera.distance, 1e-9);
    assert.equal(target.w.exportWidgets.cam_maintain_subject_size.checked, true);
    for (const character of target.w.characters) {
        assert.equal(character.poses[target.w.activeTab].cameraParams.fov_deg, 62, "the lens is shared by every character");
    }
    target.renders.length = 0;
    target.w.syncToNode(true, { executionCapture: true, skipCaptureUpload: true });
    assertSameCamera(target.renders[0], expected, "RUN output after library load");

    // Edit the pose and save again: the lens survives.
    target.viewer.setModelRotation?.(0, 15, 0);
    target.w.syncToNode(false);
    const resaved = await saveLibraryScene(target);
    assert.equal(resaved.pose.camera.fov_deg, 62);
    assert.equal(resaved.pose.cameraParams.fov_deg, 62);
    close(resaved.pose.cameraParams.distance, saved.camera.distance, 1e-9);
});

test("legacy library poses load with the 30 degree / 45 lens and do not inherit the previous pose", async () => {
    const source = lensScene();
    slide(source, "cam_fov_deg", 70);
    const wide = JSON.parse(JSON.stringify((await saveLibraryScene(source)).pose));
    const target = lensScene();
    await loadLibraryPose(target, wide);
    assert.equal(target.viewer.captureCamera.fov, 70);

    const legacyScene = JSON.parse(JSON.stringify(wide));
    delete legacyScene.camera.fov_deg; delete legacyScene.camera.distance; delete legacyScene.camera.maintain_subject_size;
    for (const holder of [legacyScene.cameraParams, ...legacyScene.characters.map(character => character.poses[0].cameraParams)]) {
        delete holder.fov_deg; delete holder.distance; delete holder.maintain_subject_size;
    }
    await loadLibraryPose(target, legacyScene);
    assert.equal(target.w.exportParams.cam_fov_deg, 30);
    assert.equal(target.w.exportParams.cam_distance, 45);
    assert.equal(target.viewer.captureCamera.fov, 30);
    close(distanceToTarget(target.viewer), 45, 1e-9);

    await loadLibraryPose(target, wide);
    await loadLibraryPose(target, { bones: {}, prompt: "flat legacy pose without camera" });
    assert.equal(target.viewer.captureCamera.fov, 30, "a camera-less legacy pose resets the lens");

    await loadLibraryPose(target, { ...wide, camera: { ...wide.camera, fov_deg: "NaN", distance: Infinity } , cameraParams: { ...wide.cameraParams, fov_deg: "bad", distance: -Infinity },
        characters: wide.characters.map(character => ({ ...character, poses: [{ ...character.poses[0], cameraParams: { ...character.poses[0].cameraParams, fov_deg: "bad", distance: null } }] })) });
    assert.equal(target.w.exportParams.cam_fov_deg, 30, "invalid saved lens values fall back safely");
    assert.equal(target.w.exportParams.cam_distance, 45);
});

test("workflow save and reload restore every tab's lens; legacy workflows use the default lens", () => {
    const source = lensScene();
    slide(source, "cam_fov_deg", 48);
    source.w.addTab();
    source.w.exportWidgets.cam_maintain_subject_size.checked = true;
    source.w.exportWidgets.cam_maintain_subject_size.emit("change");
    slide(source, "cam_fov_deg", 72);
    const expected = cameraState(source.viewer);
    const saved = source.node.widgets[0].value;
    const data = JSON.parse(saved);
    assert.equal(data.export.cam_fov_deg, 72);
    assert.equal(data.characters[0].poses[0].cameraParams.fov_deg, 48);

    const restored = lensScene();
    slide(restored, "cam_fov_deg", 20);
    restored.node.widgets[0].value = saved;
    restored.w.loadFromNode();
    restored.w.applyCameraToViewer(true);
    assertSameCamera(cameraState(restored.viewer), expected, "restored workflow camera");
    assert.equal(restored.w.exportParams.cam_maintain_subject_size, true);
    restored.w.switchTab(0);
    assert.equal(restored.viewer.captureCamera.fov, 48);

    const legacy = JSON.parse(saved);
    for (const key of ["cam_fov_deg", "cam_distance", "cam_maintain_subject_size"]) delete legacy.export[key];
    for (const pose of legacy.characters[0].poses) {
        delete pose.cameraParams.fov_deg; delete pose.cameraParams.distance; delete pose.cameraParams.maintain_subject_size;
    }
    restored.node.widgets[0].value = JSON.stringify(legacy);
    restored.w.loadFromNode();
    restored.w.applyCameraToViewer(true);
    assert.equal(restored.w.exportParams.cam_fov_deg, 30);
    assert.equal(restored.w.exportParams.cam_distance, 45);
    assert.equal(restored.viewer.captureCamera.fov, 30);

    const invalid = JSON.parse(saved);
    invalid.export.cam_fov_deg = "abc"; invalid.export.cam_distance = 1e12;
    restored.node.widgets[0].value = JSON.stringify(invalid);
    assert.doesNotThrow(() => restored.w.loadFromNode());
    assert.equal(restored.w.exportParams.cam_distance <= 250, true);
});

test("SAM projection owns the lens while applied and the manual lens returns afterwards", () => {
    const scene = lensScene();
    const { w, viewer } = scene;
    slide(scene, "cam_fov_deg", 60);
    slide(scene, "cam_distance", 70);
    const frame = { fov: 30, cameraPosition: { x: 1, y: 12, z: 40 }, projection_zoom: 0.8 };
    viewer.setSAMProjectionCameraFrame(frame);
    w._samCameraModeActive = true;
    w.applyCameraToViewer(true);
    w.syncCameraWidgets();
    assert.equal(viewer.captureCamera.fov, 30, "SAM projection keeps its own FOV");
    close(viewer.captureCamera.position.z, 40, 1e-9);
    close(viewer.captureCamera.zoom, 0.8, 1e-9);
    assert.equal(w.exportWidgets.cam_fov_deg.disabled, true);
    assert.equal(w.exportWidgets.cam_distance.disabled, true);
    assert.equal(w._captureLensSamNote.style.display, "block");
    assert.equal(w.poses[w.activeTab].cameraParams.fov_deg, 60, "manual lens is kept, not overwritten");

    w.clearSAMCameraMode();
    w.applyCameraToViewer(true);
    assert.equal(w.exportWidgets.cam_fov_deg.disabled, false);
    assert.equal(viewer.captureCamera.fov, 60);
    close(distanceToTarget(viewer), 70, 1e-9);
});

test("the editor camera backs off for wide lenses so the capture frame stays in view", () => {
    const scene = lensScene();
    const { w, viewer } = scene;
    w.applyCameraToViewer(true);
    assert.deepEqual(viewer.camera.position.toArray(), viewer.captureCamera.position.toArray());
    slide(scene, "cam_fov_deg", 75);
    const target = viewer.orbit.target;
    close(viewer.camera.position.distanceTo(target), 45 * tanHalf(75) / tanHalf(30), 1e-6);
    close(viewer.camera.fov, 40, 1e-9, "the editor FOV is not copied from the capture camera");
    const toCapture = viewer.captureCamera.position.clone().sub(target).normalize();
    const toEditor = viewer.camera.position.clone().sub(target).normalize();
    close(toCapture.dot(toEditor), 1, 1e-9, "editor stays on the capture view ray");
});
