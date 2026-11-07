import assert from "node:assert/strict";
import test from "node:test";
import { createScene, Element } from "./helpers/pose_studio_scene.mjs";
import {
    computeSubjectSizeDistance,
    MIN_CAPTURE_FOV_DEG,
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
    assert.deepEqual(normalizeCaptureLens(), { fov_deg: 30, distance: 45, maintain_subject_size: false, view: null });
    assert.deepEqual(normalizeCaptureLens(null), { fov_deg: 30, distance: 45, maintain_subject_size: false, view: null });
    for (const value of [NaN, Infinity, -Infinity, "abc", "", " ", null, undefined, true, {}, []]) {
        assert.deepEqual(
            normalizeCaptureLens({ fov_deg: value, distance: value, maintain_subject_size: value }),
            { fov_deg: 30, distance: 45, maintain_subject_size: value === true, view: null },
            String(value),
        );
    }
    assert.deepEqual(normalizeCaptureLens({ fov_deg: 1, distance: 0 }), { fov_deg: 15, distance: 10, maintain_subject_size: false, view: null });
    assert.deepEqual(normalizeCaptureLens({ fov_deg: 179, distance: 1e9 }), { fov_deg: 75, distance: 250, maintain_subject_size: false, view: null });
    assert.deepEqual(normalizeCaptureLens({ fov_deg: "50", distance: "60", maintain_subject_size: true }), { fov_deg: 50, distance: 60, maintain_subject_size: true, view: null });
    assert.deepEqual(
        resolveCaptureCameraParams({ yaw_deg: 10 }, {}),
        { zoom: 1, offset_x: 0, offset_y: 0, yaw_deg: 10, pitch_deg: 0, fov_deg: 30, distance: 45, maintain_subject_size: false, view: null },
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

test("FOV and Distance use the same editable value, reset and slider as the other camera controls", () => {
    const { w, section } = lensScene();
    for (const [field, key, value] of [
        [section.content.children[0], "cam_fov_deg", "30.00"],
        [section.content.children[1], "cam_distance", "45.00"],
    ]) {
        const slider = w.exportWidgets[key];
        const [labelRow, sliderWrap] = field.children;
        const valueRow = labelRow.children[1];
        assert.equal(valueRow.children[0], slider._vnccsNumberInput);
        assert.equal(slider._vnccsNumberInput.type, "number");
        assert.equal(slider._vnccsNumberInput.className, w.exportWidgets.cam_yaw_deg._vnccsNumberInput.className);
        assert.equal(slider._vnccsNumberInput.value, value);
        assert.equal(valueRow.children[1].className, "vnccs-ps-reset-btn");
        assert.deepEqual(sliderWrap.children, [slider]);
        assert.equal(field.children.length, 2);
        assert.equal(Number(slider.step), 0.1);
    }
});

test("lens fields follow the sliders and Maintain Subject Size during a gesture", () => {
    const scene = lensScene();
    const { w } = scene;
    const fov = w.exportWidgets.cam_fov_deg;
    const distance = w.exportWidgets.cam_distance;
    w.exportWidgets.cam_maintain_subject_size.checked = true;
    w.exportWidgets.cam_maintain_subject_size.emit("change");
    fov.emit("pointerdown");
    for (const value of [33, 41, 58.5]) {
        fov.value = String(value);
        fov.emit("input");
        assert.equal(fov._vnccsNumberInput.value, value.toFixed(2));
        assert.equal(distance._vnccsNumberInput.value, w.exportParams.cam_distance.toFixed(2));
        assert.equal(Number(distance.value), w.exportParams.cam_distance);
    }
    fov.emit("change");
    fov.emit("pointerup");
    const resetButton = fov.parentElement.parentElement.children[0].children[1].children[1];
    resetButton.onclick({ stopPropagation: noop });
    assert.equal(fov._vnccsNumberInput.value, "30.00");
});

test("typing camera values updates the lens live and commits one Undo per edit", () => {
    const { w, viewer, document } = lensScene();
    const fov = w.exportWidgets.cam_fov_deg;
    const input = fov._vnccsNumberInput;
    const distance = w.exportWidgets.cam_distance;
    w.exportWidgets.cam_maintain_subject_size.checked = true;
    w.exportWidgets.cam_maintain_subject_size.emit("change");
    const history = viewer.history.length;
    document.activeElement = input;
    input.value = "";
    input.emit("input");
    assert.equal(viewer.history.length, history);
    for (const value of ["4", "42", "42.5"]) {
        input.value = value;
        input.emit("input");
        const expected = Math.max(MIN_CAPTURE_FOV_DEG, Number(value));
        assert.equal(viewer.captureCamera.fov, expected);
        assert.equal(Number(fov.value), expected);
        assert.equal(input.value, value, "the active draft remains editable");
        assert.equal(distance._vnccsNumberInput.value, w.exportParams.cam_distance.toFixed(2));
    }
    input.emit("keydown", { key: "Enter" });
    assert.equal(input.value, "42.50");
    assert.equal(viewer.history.length, history + 1);
    viewer.undo();
    assert.equal(viewer.captureCamera.fov, 30);
    assert.equal(input.value, "30.00", "the committed field follows Undo even while focused");
    document.activeElement = null;
    input.emit("blur");

    distance._vnccsNumberInput.value = "80.1";
    distance._vnccsNumberInput.emit("input");
    close(distanceToTarget(viewer), 80.1);
    distance._vnccsNumberInput.emit("blur");
});

// Two points one unit apart vertically, at a given depth along the camera axis.
function apparentSize(camera, depthOffset, T) {
    camera.updateMatrixWorld(true);
    camera.updateProjectionMatrix();
    const forward = new T.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    const up = new T.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
    const center = camera.__subject.clone().addScaledVector(forward, -depthOffset);
    const a = center.clone().project(camera);
    const b = center.clone().add(up).project(camera);
    return Math.abs(b.y - a.y);
}

test("the lens is a real perspective: FOV frames, Distance with FOV changes near and far proportions", () => {
    const scene = lensScene();
    const { w, viewer } = scene;
    const T = viewer.THREE;
    const NEAR = 8;
    const FAR = -8;
    const measure = camera => {
        camera.__subject = viewer.sceneCameraTarget.clone();
        const near = apparentSize(camera, NEAR, T);
        const mid = apparentSize(camera, 0, T);
        const far = apparentSize(camera, FAR, T);
        return { near, mid, far, ratio: near / far };
    };
    const both = () => ({ capture: measure(viewer.captureCamera), editor: measure(viewer.camera) });

    const start = both();
    close(start.capture.ratio, (45 + 8) / (45 - 8), 1e-6, "default near/far ratio");
    close(start.editor.ratio, start.capture.ratio, 1e-6, "the viewport shows the capture perspective");

    // FOV at a fixed camera position changes the framing, never the proportions.
    const position = viewer.captureCamera.position.toArray();
    slide(scene, "cam_fov_deg", 60);
    const wide = both();
    assert.deepEqual(viewer.captureCamera.position.toArray(), position, "the camera does not move");
    assert.ok(wide.capture.mid < start.capture.mid * 0.6, "the frame shows more of the scene");
    close(wide.capture.mid, start.capture.mid * tanHalf(30) / tanHalf(60), 1e-6, "framing follows tan(fov / 2)");
    close(wide.capture.ratio, start.capture.ratio, 1e-6, "proportions are unchanged");
    close(wide.editor.ratio, start.capture.ratio, 1e-6, "viewport proportions are unchanged");
    close(wide.editor.mid, start.editor.mid * tanHalf(45) / tanHalf(viewer.camera.fov), 1e-6, "the viewport frames more of the scene too");

    // Distance with a compensating FOV changes the proportions and keeps the subject size.
    slide(scene, "cam_fov_deg", 30);
    w.exportWidgets.cam_maintain_subject_size.checked = true;
    w.exportWidgets.cam_maintain_subject_size.emit("change");
    for (const fov of [15, 60, 75]) {
        slide(scene, "cam_fov_deg", fov);
        const distance = w.exportParams.cam_distance;
        close(distance, 45 * tanHalf(30) / tanHalf(fov), 1e-6, `Distance at FOV ${fov}`);
        const lens = both();
        close(lens.capture.mid, start.capture.mid, 1e-6, `subject size in RUN at FOV ${fov}`);
        close(lens.editor.mid, start.editor.mid, 1e-6, `subject size in the viewport at FOV ${fov}`);
        close(lens.capture.ratio, (distance + 8) / (distance - 8), 1e-6, `near/far in RUN at FOV ${fov}`);
        close(lens.editor.ratio, lens.capture.ratio, 1e-6, `near/far in the viewport at FOV ${fov}`);
        assert.notEqual(Math.round(lens.capture.ratio * 100), Math.round(start.capture.ratio * 100), `perspective changes at FOV ${fov}`);
    }
});

test("Undo and Redo restore the editor camera with the capture lens", () => {
    const scene = lensScene();
    const { w, viewer } = scene;
    w.applyCameraToViewer(true);
    const start = {
        fov: viewer.camera.fov,
        zoom: viewer.camera.zoom,
        position: viewer.camera.position.toArray(),
        capture: cameraState(viewer),
    };
    close(start.fov, 45, 1e-9);

    slide(scene, "cam_fov_deg", 62);
    close(tanHalf(viewer.camera.fov), tanHalf(62) * tanHalf(45) / tanHalf(30), 1e-9, "the editor lens follows FOV 62");
    close(viewer.camera.fov, 85.77, 0.01);
    const wide = { fov: viewer.camera.fov, capture: cameraState(viewer) };

    viewer.undo();
    assert.equal(w.exportParams.cam_fov_deg, 30);
    assertSameCamera(cameraState(viewer), start.capture, "capture after Undo");
    close(viewer.camera.fov, start.fov, 1e-9, "the editor FOV returns to 45");
    close(viewer.camera.projectionMatrix.elements[5], 1 / tanHalf(45) * start.zoom, 1e-9, "the editor projection is rebuilt");
    assert.deepEqual(viewer.camera.position.toArray(), start.position, "the editor distance returns");
    assert.equal(String(w.exportWidgets.cam_fov_deg.value), "30", "the slider returns");
    assert.equal(w.exportWidgets.cam_fov_deg._vnccsNumberInput.value, "30.00", "the value label returns");

    viewer.redo();
    assert.equal(w.exportParams.cam_fov_deg, 62);
    close(viewer.camera.fov, wide.fov, 1e-9, "Redo restores the editor FOV");
    assertSameCamera(cameraState(viewer), wide.capture, "capture after Redo");

    // Distance: the editor camera position returns with the lens distance.
    viewer.undo();
    slide(scene, "cam_distance", 80);
    close(viewer.camera.position.distanceTo(viewer.orbit.target), 80, 1e-6);
    viewer.undo();
    close(viewer.camera.position.distanceTo(viewer.orbit.target), 45, 1e-6, "the editor distance returns after Undo");

    // A view the user moved keeps its direction and pivot through Undo.
    const T = viewer.THREE;
    viewer.camera.position.add(new T.Vector3(9, 4, -6));
    viewer.orbit.target.add(new T.Vector3(1, 2, 0));
    viewer.orbit.update();
    const target = viewer.orbit.target.toArray();
    const direction = () => viewer.camera.position.clone().sub(viewer.orbit.target).normalize();
    const movedDirection = direction();
    const movedDistance = viewer.camera.position.distanceTo(viewer.orbit.target);
    slide(scene, "cam_fov_deg", 62);
    slide(scene, "cam_distance", 90);
    viewer.undo();
    viewer.undo();
    assert.deepEqual(viewer.orbit.target.toArray(), target, "Undo keeps the moved pivot");
    close(direction().dot(movedDirection), 1, 1e-12, "Undo keeps the moved direction");
    close(viewer.camera.fov, 45, 1e-9, "Undo restores the editor FOV on a moved view");
    close(viewer.camera.position.distanceTo(viewer.orbit.target), movedDistance, 1e-6, "Undo restores the moved view distance");
});

test("the SAM standard fit keeps the lens it measured with", () => {
    const scene = lensScene();
    const { w, viewer } = scene;
    viewer.sceneCameraTarget = viewer.sceneCameraTarget || new viewer.THREE.Vector3(0, 10, 0);
    slide(scene, "cam_fov_deg", 60);
    slide(scene, "cam_distance", 80);
    const seen = [];
    const record = () => seen.push({
        fov: viewer.captureCamera.fov,
        distance: viewer.captureLens.distance,
        view: viewer.captureLens.view,
    });
    const framing = { zoom: 1.3, offset_x: 0.5, offset_y: -0.25 };
    viewer.fitSAM3DToStandardCamera = () => { record(); return framing; };
    viewer.computeSAM3DFrameCameraParams = () => { record(); return { zoom: 1, offset_x: 0, offset_y: 0 }; };

    assert.equal(w.applySAM3DStandardCameraFit({}, {}, {}), true);
    assert.ok(seen.length >= 2);
    for (const lens of seen) {
        assert.equal(lens.fov, 60, "measured through the current FOV");
        assert.equal(lens.distance, 80, "measured at the current Distance");
    }
    assert.equal(w.exportParams.cam_fov_deg, 60, "the lens survives the fit");
    assert.equal(w.exportParams.cam_distance, 80);
    assert.equal(viewer.captureCamera.fov, 60, "the capture camera keeps the measured lens");
    close(distanceToTarget(viewer), 80, 1e-6, "the capture camera keeps the measured distance");
    assert.equal(w.poses[w.activeTab].cameraParams.fov_deg, 60, "the pose stores the measured lens");
    assert.equal(w.poses[w.activeTab].cameraParams.distance, 80);
    assert.equal(w.exportWidgets.cam_fov_deg._vnccsNumberInput.value, "60.00");

    // An aligned view does not apply to the standard front camera.
    w.setExportCaptureLens({
        ...w.currentCaptureLens(),
        view: { position: [5, 12, 60], target: [0, 10, 0], quaternion: [0, 0, 0, 1], zoom: 1.5 },
    });
    assert.equal(w.applySAM3DStandardCameraFit({}, {}, {}), true);
    assert.equal(w.exportParams.cam_view, null, "the fit uses the regular camera");
    assert.equal(seen.at(-1).view, null);

    // A failed fit restores everything, including an aligned view.
    const view = { position: [5, 12, 60], target: [0, 10, 0], quaternion: [0, 0, 0, 1], zoom: 1.5 };
    w.setExportCaptureLens({ fov_deg: 50, distance: 70, view });
    viewer.fitSAM3DToStandardCamera = () => null;
    assert.equal(w.applySAM3DStandardCameraFit({}, {}, {}), false);
    assert.equal(w.exportParams.cam_fov_deg, 50);
    assert.equal(w.exportParams.cam_distance, 70);
    assert.deepEqual(w.exportParams.cam_view.position, view.position, "the aligned view comes back");
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
    close(viewer.camera.fov, 45, 1e-9, "SAM keeps the default editor view");
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
    close(tanHalf(viewer.camera.fov), tanHalf(60) * tanHalf(45) / tanHalf(30), 1e-9, "editor lens follows the manual lens again");
});

test("the editor lens follows the capture lens and keeps the capture frame size", () => {
    const scene = lensScene();
    const { w, viewer } = scene;
    // Fraction of the editor viewport height that the capture frame covers.
    const frameFraction = () => tanHalf(viewer.captureCamera.fov) / tanHalf(viewer.camera.fov);
    w.applyCameraToViewer(true);
    close(viewer.camera.fov, 45, 1e-9, "the default lens keeps the 45 degree editor view");
    const defaultFraction = frameFraction();
    for (const fov of [15, 22, 30, 50, 75]) {
        w.exportWidgets.cam_fov_deg.emit("pointerdown");
        w.exportWidgets.cam_fov_deg.value = String(fov);
        w.exportWidgets.cam_fov_deg.emit("input");
        // The viewport updates during the drag, before the gesture ends.
        assert.equal(viewer.captureCamera.fov, fov);
        close(frameFraction(), defaultFraction, 1e-9, `frame size at ${fov} degrees`);
        assert.deepEqual(viewer.camera.position.toArray(), viewer.captureCamera.position.toArray(),
            "the editor views the subject from the capture position, with its perspective");
        const head = viewer.orbit.target.clone().add(new viewer.THREE.Vector3(1.5, 6, 2));
        const projected = head.clone().project(viewer.camera);
        const captured = head.clone().project(viewer.captureCamera);
        close(projected.x, captured.x * defaultFraction, 1e-9, "subject sits where the capture puts it inside the frame");
        close(projected.y, captured.y * defaultFraction, 1e-9, "subject sits where the capture puts it inside the frame");
        w.exportWidgets.cam_fov_deg.emit("change");
        w.exportWidgets.cam_fov_deg.emit("pointerup");
    }
});

test("FOV and Distance apply to a view the user moved without resetting it", () => {
    const scene = lensScene();
    const { w, viewer } = scene;
    const T = viewer.THREE;
    const frameFraction = () => tanHalf(viewer.captureCamera.fov) / tanHalf(viewer.camera.fov);
    w.applyCameraToViewer(true);
    const defaultFraction = frameFraction();
    viewer.camera.position.add(new T.Vector3(9, 4, -6));
    viewer.orbit.target.add(new T.Vector3(1, 2, 0));
    viewer.orbit.update();
    const target = viewer.orbit.target.toArray();
    const direction = () => viewer.camera.position.clone().sub(viewer.orbit.target).normalize();
    const startDirection = direction();
    let viewDistance = viewer.camera.position.distanceTo(viewer.orbit.target);
    let lensDistance = w.exportParams.cam_distance;
    for (const [key, value] of [["cam_fov_deg", 62], ["cam_distance", 80], ["cam_fov_deg", 18], ["cam_distance", 30]]) {
        const before = cameraState(viewer);
        slide(scene, key, value);
        assert.deepEqual(viewer.orbit.target.toArray(), target, `${key} keeps the orbit pivot`);
        close(direction().dot(startDirection), 1, 1e-12, `${key} keeps the view direction`);
        // The view shows the capture perspective with the frame at its usual size.
        close(frameFraction(), defaultFraction, 1e-9, `${key} frame size`);
        // Distance scales the user's own view distance by the lens change.
        viewDistance *= w.exportParams.cam_distance / lensDistance;
        lensDistance = w.exportParams.cam_distance;
        close(viewer.camera.position.distanceTo(viewer.orbit.target), viewDistance, 1e-9, `${key} view distance`);
        assert.notDeepEqual(cameraState(viewer), before, `${key} updates the capture camera`);
        assert.notDeepEqual(viewer.camera.position.toArray(), viewer.captureCamera.position.toArray(), `${key} does not jump to the capture camera`);
    }
    assert.equal(viewer.captureCamera.fov, 18);
    close(distanceToTarget(viewer), 30, 1e-9);
    // Yaw still previews from the capture camera, and lens edits follow the snapped view again.
    slide(scene, "cam_yaw_deg", 25);
    assert.deepEqual(viewer.camera.position.toArray(), viewer.captureCamera.position.toArray());
    slide(scene, "cam_fov_deg", 40);
    assert.deepEqual(viewer.camera.position.toArray(), viewer.captureCamera.position.toArray());
});

// --- Align Camera to View (editor -> capture; snapToCaptureCamera is capture -> editor) ---

function findButton(scene, text) {
    const walk = node => node.children?.flatMap(child => [child, ...walk(child)]) || [];
    return walk(scene.section.content).find(element => element.tagName === "BUTTON" && element.innerText === text);
}

function moveEditor(viewer, { position, target, fov, zoom = 1 }) {
    viewer.camera.position.set(...position);
    viewer.orbit.target.set(...target);
    viewer.orbit.update();
    viewer.camera.fov = fov;
    viewer.camera.zoom = zoom;
    viewer.camera.updateProjectionMatrix();
    viewer.camera.updateMatrixWorld(true);
}

function meshPoints(viewer) {
    viewer.skinnedMesh.updateMatrixWorld(true);
    const positions = viewer.skinnedMesh.geometry.attributes.position;
    const points = [];
    for (let index = 0; index < positions.count; index += 53) {
        points.push(new viewer.THREE.Vector3().fromBufferAttribute(positions, index).applyMatrix4(viewer.skinnedMesh.matrixWorld));
    }
    return points;
}

// Every sampled mannequin vertex lands at the same point inside the fitted frame.
function assertFrameComposition(points, editor, capture, message, outputAspect = editor.aspect) {
    editor.updateMatrixWorld(true);
    capture.updateMatrixWorld(true);
    const frameHeight = Math.min(1, editor.aspect / outputAspect);
    for (const point of points) {
        const a = point.clone().project(editor);
        const b = point.clone().project(capture);
        close(b.x, a.x * editor.aspect / outputAspect / frameHeight, 1e-9, `${message} x`);
        close(b.y, a.y / frameHeight, 1e-9, `${message} y`);
    }
}

function sceneSnapshot(scene) {
    const { w, viewer } = scene;
    viewer.skinnedMesh.updateMatrixWorld(true);
    return {
        transforms: JSON.stringify(w.characters.map(character => character.transform)),
        mesh: viewer.skinnedMesh.matrixWorld.toArray(),
        // The pose without the scene camera it also reports.
        pose: JSON.stringify({ ...viewer.getPose(), camera: null, cameraParams: null }),
    };
}

const editorView = { position: [17, 23, 29], target: [2, 9, -3], fov: 52, zoom: 1.3 };

test("Align Camera to View copies the editor position, rotation and zoom and captures the frame without touching characters", () => {
    const scene = lensScene();
    const { w, viewer } = scene;
    const second = scene.context.createPoseStudioCharacter({ index: 1, mesh: w.meshParams, transform: { x: 6, y: 1, zoom: 0.9 } });
    w.characters.push(second); w.ensurePoseCameraParams();
    w.updateCharacterScene();
    moveEditor(viewer, editorView);
    const before = sceneSnapshot(scene);
    const editorWorld = viewer.camera.matrixWorld.toArray();
    findButton(scene, "Align Camera to View").click();

    const view = w.exportParams.cam_view;
    assert.deepEqual(view.position, editorView.position);
    viewer.captureCamera.updateMatrixWorld(true);
    viewer.captureCamera.matrixWorld.toArray().forEach((value, index) => close(value, editorWorld[index], 1e-9, `world[${index}]`));
    close(viewer.captureCamera.fov, 52, 1e-9, "the lens is the part of the view the frame covers");
    close(viewer.captureCamera.zoom, 1.3, 1e-12);
    close(w.exportParams.cam_fov_deg, 52, 1e-9, "the FOV control shows the capture lens");
    close(w.exportParams.cam_distance, new viewer.THREE.Vector3(...editorView.position).distanceTo(new viewer.THREE.Vector3(...editorView.target)), 1e-9);
    assertFrameComposition(meshPoints(viewer), viewer.camera, viewer.captureCamera, "aligned capture");
    assert.deepEqual(sceneSnapshot(scene), before, "characters keep their position, size and joints");
    assert.deepEqual(viewer.camera.matrixWorld.toArray(), editorWorld, "the editor keeps its view");

    // The final RUN capture renders through exactly that camera.
    const expected = cameraState(viewer);
    scene.renders.length = 0;
    w.syncToNode(true, { executionCapture: true, skipCaptureUpload: true });
    assert.equal(scene.renders.length, 1);
    assertSameCamera(scene.renders[0], expected, "RUN output");

    // Moving the editor afterwards does not move the capture camera.
    moveEditor(viewer, { position: [-30, 4, 10], target: [0, 10, 0], fov: 45 });
    w.applyCameraToViewer(false);
    assertSameCamera(cameraState(viewer), expected, "capture after editor orbit");
    for (const character of w.characters) {
        assert.deepEqual(character.poses[0].cameraParams.view, view, "every character shares the aligned view");
    }
});

test("Align fits the output frame to each viewport aspect without changing the editor camera", () => {
    const { w, viewer } = lensScene();
    viewer.captureFrame = new viewer.THREE.Object3D();
    for (const [viewportAspect, outputAspect, frameWidth, frameHeight] of [
        [2, 0.5, 0.25, 1], [2, 1, 0.5, 1], [2, 2, 1, 1],
        [1, 0.5, 0.5, 1], [1, 1, 1, 1], [1, 2, 1, 0.5],
        [0.5, 0.5, 1, 1], [0.5, 1, 1, 0.5], [0.5, 2, 1, 0.25],
    ]) {
        viewer.camera.aspect = viewportAspect;
        moveEditor(viewer, editorView);
        w.exportParams.view_width = 1024 * outputAspect;
        w.exportParams.view_height = 1024;
        const projection = viewer.camera.projectionMatrix.toArray();
        const world = viewer.camera.matrixWorld.toArray();
        const target = viewer.orbit.target.toArray();
        w.alignCaptureCameraToView();
        assert.deepEqual(viewer.camera.projectionMatrix.toArray(), projection);
        assert.deepEqual(viewer.camera.matrixWorld.toArray(), world);
        assert.deepEqual(viewer.orbit.target.toArray(), target);
        assertFrameComposition(meshPoints(viewer), viewer.camera, viewer.captureCamera,
            `${viewportAspect} viewport / ${outputAspect} output`, outputAspect);
        viewer.captureFrame.updateMatrixWorld(true);
        for (const [x, y] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
            const corner = new viewer.THREE.Vector3(x, y, 0)
                .applyMatrix4(viewer.captureFrame.matrixWorld).project(viewer.camera);
            close(corner.x, x * frameWidth, 1e-9, "frame fills the available width");
            close(corner.y, y * frameHeight, 1e-9, "frame fills the available height");
        }
    }
});

test("Align fits the unchanged editor view after lens edits and Preview", () => {
    const scene = lensScene();
    const { w, viewer } = scene;
    slide(scene, "cam_yaw_deg", -14);
    for (const fov of [62, 75, 15, 30]) {
        slide(scene, "cam_distance", 11.87);
        slide(scene, "cam_fov_deg", fov);
        const projection = viewer.camera.projectionMatrix.toArray();
        const world = viewer.camera.matrixWorld.toArray();
        w.alignCaptureCameraToView();
        close(w.exportParams.cam_distance, 11.87, 1e-9);
        assert.deepEqual(viewer.camera.projectionMatrix.toArray(), projection);
        assert.deepEqual(viewer.camera.matrixWorld.toArray(), world);
        assertFrameComposition(meshPoints(viewer), viewer.camera, viewer.captureCamera, `FOV ${fov}`);
        w.resetCaptureCamera();
    }
    moveEditor(viewer, editorView);
    w.alignCaptureCameraToView();
    w.applyCameraToViewer(true);
    const projection = viewer.camera.projectionMatrix.toArray();
    const world = viewer.camera.matrixWorld.toArray();
    w.alignCaptureCameraToView();
    const aligned = cameraState(viewer);
    for (let repeat = 0; repeat < 3; repeat += 1) w.alignCaptureCameraToView();
    assertSameCamera(cameraState(viewer), aligned, "repeated Align without moving the viewport");
    assert.deepEqual(viewer.camera.projectionMatrix.toArray(), projection);
    assert.deepEqual(viewer.camera.matrixWorld.toArray(), world);
    assertFrameComposition(meshPoints(viewer), viewer.camera, viewer.captureCamera, "Align after Preview");
});

test("editor FOV and distance outside the lens range keep the exact image", () => {
    const scene = lensScene();
    const { w, viewer } = scene;
    for (const fov of [120, 10]) {
        moveEditor(viewer, { ...editorView, fov, zoom: 1 });
        w.alignCaptureCameraToView();
        assert.equal(viewer.captureCamera.fov, fov > 45 ? 75 : 15, "the lens is clamped");
        assertFrameComposition(meshPoints(viewer), viewer.camera, viewer.captureCamera, `editor ${fov} degrees carried by zoom`);
    }

    // Closer than the minimum distance: the pivot moves along the ray, the camera does not.
    moveEditor(viewer, { position: [0, 12, 6], target: [0, 11, 2], fov: 40 });
    const editorWorld = viewer.camera.matrixWorld.toArray();
    w.alignCaptureCameraToView();
    assert.equal(w.exportParams.cam_distance, 10);
    viewer.captureCamera.updateMatrixWorld(true);
    viewer.captureCamera.matrixWorld.toArray().forEach((value, index) => close(value, editorWorld[index], 1e-9, `world[${index}]`));
    assertFrameComposition(meshPoints(viewer), viewer.camera, viewer.captureCamera, "short distance");
});

test("aligned view: Distance moves along the view ray, Yaw/Pitch orbit it around its pivot, reset clears it", () => {
    const scene = lensScene();
    const { w, viewer } = scene;
    moveEditor(viewer, editorView);
    w.alignCaptureCameraToView();
    const quaternion = viewer.captureCamera.quaternion.toArray();
    // Yaw and Pitch show the aligned direction and stay usable.
    const ray = [15, 14, 32];
    const length = Math.hypot(...ray);
    close(w.exportParams.cam_yaw_deg, Math.atan2(15, 32) * 180 / Math.PI, 1e-9);
    close(w.exportParams.cam_pitch_deg, -Math.asin(14 / length) * 180 / Math.PI, 1e-9);
    assert.notEqual(w.exportWidgets.cam_yaw_deg.disabled, true);
    assert.notEqual(w.exportWidgets.cam_pitch_deg.disabled, true);
    assert.notEqual(findButton(scene, "Reset Camera").disabled, true);
    assert.equal(w._captureViewNote.style.display, "block");

    slide(scene, "cam_distance", 80);
    const target = new viewer.THREE.Vector3(...w.exportParams.cam_view.target);
    close(viewer.captureCamera.position.distanceTo(target), 80, 1e-9);
    const direction = viewer.captureCamera.position.clone().sub(target).normalize();
    const original = new viewer.THREE.Vector3(...editorView.position).sub(new viewer.THREE.Vector3(...editorView.target)).normalize();
    close(direction.dot(original), 1, 1e-12, "same view ray");
    viewer.captureCamera.quaternion.toArray().forEach((value, index) => close(value, quaternion[index], 1e-12));
    slide(scene, "cam_fov_deg", 35);
    assert.equal(viewer.captureCamera.fov, 35);
    close(viewer.captureCamera.position.distanceTo(target), 80, 1e-9, "FOV alone keeps the camera in place");

    // Setting the aligned angles again changes nothing; new angles orbit the pivot.
    const aligned = cameraState(viewer);
    slide(scene, "cam_yaw_deg", w.exportParams.cam_yaw_deg);
    assertSameCamera(cameraState(viewer), aligned, "same yaw");
    const viewZoom = w.exportParams.cam_view.zoom;
    slide(scene, "cam_yaw_deg", -50);
    slide(scene, "cam_pitch_deg", 20);
    const offset = new viewer.THREE.Vector3(0, 0, 80).applyEuler(new viewer.THREE.Euler(20 * Math.PI / 180, -50 * Math.PI / 180, 0, "YXZ"));
    const expectedPosition = target.clone().add(offset);
    viewer.captureCamera.position.toArray().forEach((value, index) => close(value, expectedPosition.toArray()[index], 1e-9, `orbit position[${index}]`));
    const forward = new viewer.THREE.Vector3(0, 0, -1).applyQuaternion(viewer.captureCamera.quaternion);
    close(forward.dot(offset.clone().normalize().negate()), 1, 1e-12, "the camera looks at the pivot");
    assert.deepEqual(w.exportParams.cam_view.target, target.toArray(), "the pivot stays");
    assert.equal(w.exportParams.cam_view.zoom, viewZoom);
    assert.equal(viewer.captureCamera.fov, 35);
    for (const character of w.characters) {
        assert.deepEqual(character.poses[0].cameraParams.view, w.exportParams.cam_view, "the rotated view is stored with the pose");
    }
    assert.equal(w._captureViewNote.style.display, "block");

    findButton(scene, "Reset Camera").click();
    assert.equal(w.exportParams.cam_view, null);
    assert.notEqual(w.exportWidgets.cam_yaw_deg.disabled, true);
    assert.equal(viewer.captureCamera.fov, 30, "Reset Camera restores the default lens");
    close(distanceToTarget(viewer), 45, 1e-9);
    assert.equal(w.exportParams.cam_yaw_deg, 0);
    assert.equal(w.exportParams.cam_pitch_deg, 0);
    slide(scene, "cam_yaw_deg", 40);
    const back = viewer.captureCamera.position.clone().sub(viewer.sceneCameraTarget).normalize();
    close(back.x, Math.sin(40 * Math.PI / 180), 1e-9, "yaw drives the regular camera from reset pitch");

    w.alignCaptureCameraToView();
    w.resetCameraParams();
    w.applyCameraToViewer(true);
    assert.equal(w.exportParams.cam_view, null, "camera reset returns to the default composition");
    assert.equal(viewer.captureCamera.fov, 30);
});

test("undo and redo restore the capture camera around Align Camera to View", () => {
    const scene = lensScene();
    const { w, viewer } = scene;
    slide(scene, "cam_yaw_deg", 20);
    const orbit = cameraState(viewer);
    moveEditor(viewer, editorView);
    w.alignCaptureCameraToView();
    const aligned = cameraState(viewer);
    viewer.undo();
    assert.equal(w.exportParams.cam_view, null);
    assertSameCamera(cameraState(viewer), orbit, "undo");
    viewer.redo();
    assert.deepEqual(w.exportParams.cam_view.position, editorView.position);
    assertSameCamera(cameraState(viewer), aligned, "redo");
    findButton(scene, "Reset Camera").click();
    viewer.undo();
    assertSameCamera(cameraState(viewer), aligned, "undo Reset Camera");
});

test("pose tabs, characters, RUN and Pose Manager cards each use their own aligned view", async () => {
    const scene = lensScene();
    const { w, viewer } = scene;
    const second = scene.context.createPoseStudioCharacter({ index: 1, mesh: w.meshParams, transform: { x: 6, y: 0, zoom: 1 } });
    w.characters.push(second); w.ensurePoseCameraParams();
    moveEditor(viewer, editorView);
    w.alignCaptureCameraToView();
    const first = cameraState(viewer);
    w.addTab();
    assert.equal(w.exportParams.cam_view, null, "a new pose tab starts with the orbit camera");
    const orbit = cameraState(viewer);
    w.switchTab(0);
    assertSameCamera(cameraState(viewer), first, "tab 0");
    await w.selectCharacter(second.id);
    assertSameCamera(cameraState(viewer), first, "switching character keeps the shared view");
    w.switchTab(1);
    assertSameCamera(cameraState(viewer), orbit, "tab 1");
    for (const character of w.characters) {
        assert.deepEqual(character.poses[0].cameraParams.view.position, editorView.position);
        assert.equal(character.poses[1].cameraParams.view, null);
    }

    scene.renders.length = 0;
    w.syncToNode(true, { executionCapture: true, skipCaptureUpload: true });
    assert.equal(scene.renders.length, 2);
    assertSameCamera(scene.renders[0], first, "RUN tab 0");
    assertSameCamera(scene.renders[1], orbit, "RUN tab 1");

    w.interfaceMode = "manager";
    w.renderPoseManager = noop;
    w.updatePoseManagerPreviewImage = noop;
    scene.renders.length = 0;
    w.scheduleAllManagerPreviewRefresh();
    for (const [id, frame] of [...scene.frames]) { scene.frames.delete(id); frame(); }
    // Manager cards fit every pose into the card (zoom and pan) through each pose's
    // own camera angle and lens, as they do for the orbit camera.
    const rotation = world => [0, 1, 2, 4, 5, 6, 8, 9, 10].map(index => world[index]);
    for (const [render, expected] of [[scene.renders[0], first], [scene.renders[1], orbit]]) {
        assert.equal(render.fov, expected.fov);
        rotation(render.world).forEach((value, index) => close(value, rotation(expected.world)[index], 1e-9, "manager card rotation"));
    }
    const cards = w.poseCaptures.slice();
    scene.renders.length = 0;
    w.syncToNode(true, { executionCapture: true, skipCaptureUpload: true });
    assert.equal(scene.renders.length, 0, "RUN reuses the manager cards");
    assert.deepEqual(w._executionCaptureSnapshot, cards);
});

test("Pose Library and workflows reproduce the aligned composition after reload", async () => {
    const source = lensScene();
    const { w } = source;
    const second = source.context.createPoseStudioCharacter({ index: 1, mesh: w.meshParams, transform: { x: 7, y: -2, zoom: 1.2 } });
    w.characters.push(second); w.ensurePoseCameraParams();
    w.updateCharacterScene();
    moveEditor(source.viewer, editorView);
    w.alignCaptureCameraToView();
    const expected = cameraState(source.viewer);
    const expectedBounds = source.projection();
    source.renders.length = 0;
    const record = await saveLibraryScene(source);
    assertSameCamera(source.renders[0], expected, "library preview");
    const saved = JSON.parse(JSON.stringify(record.pose));
    for (const holder of [saved.camera, saved.cameraParams, ...saved.characters.map(character => character.poses[0].cameraParams)]) {
        assert.deepEqual(holder.view.position, editorView.position);
    }

    // Another workflow with its own orbit camera and lens.
    const target = lensScene();
    const targetSecond = target.context.createPoseStudioCharacter({ index: 1, mesh: target.w.meshParams });
    target.w.characters.push(targetSecond); target.w.ensurePoseCameraParams();
    slide(target, "cam_yaw_deg", -50);
    slide(target, "cam_fov_deg", 18);
    await loadLibraryPose(target, saved);
    assertSameCamera(cameraState(target.viewer), expected, "library load");
    assert.deepEqual(target.projection(), expectedBounds);
    target.renders.length = 0;
    target.w.syncToNode(true, { executionCapture: true, skipCaptureUpload: true });
    assertSameCamera(target.renders[0], expected, "RUN after library load");
    const resaved = await saveLibraryScene(target);
    assert.deepEqual(resaved.pose.camera.view, saved.camera.view, "re-saving keeps the view");

    // Workflow save and reload.
    const workflow = target.node.widgets[0].value;
    assert.deepEqual(JSON.parse(workflow).export.cam_view.position, editorView.position);
    const restored = lensScene();
    restored.node.widgets[0].value = workflow;
    restored.w.loadFromNode();
    restored.w.applyCameraToViewer(true);
    assertSameCamera(cameraState(restored.viewer), expected, "workflow reload");

    // Data without a view, or with a broken one, uses the orbit camera.
    const legacy = JSON.parse(workflow);
    delete legacy.export.cam_view;
    for (const pose of legacy.characters.flatMap(character => character.poses)) delete pose.cameraParams.view;
    restored.node.widgets[0].value = JSON.stringify(legacy);
    restored.w.loadFromNode();
    assert.equal(restored.w.exportParams.cam_view, null);
    const broken = JSON.parse(workflow);
    broken.export.cam_view = { position: [1, "x", 3], target: [0, 0, 0], quaternion: [0, 0, 0, 1] };
    broken.characters[0].poses[0].cameraParams.view = { position: [0, 0, 0], target: [0, 0, 0], quaternion: [0, 0, 0, 1] };
    restored.node.widgets[0].value = JSON.stringify(broken);
    assert.doesNotThrow(() => restored.w.loadFromNode());
    assert.equal(restored.w.exportParams.cam_view, null);
});

test("an applied SAM camera blocks Align Camera to View and keeps the stored view", () => {
    const scene = lensScene();
    const { w, viewer } = scene;
    moveEditor(viewer, editorView);
    w.alignCaptureCameraToView();
    const aligned = cameraState(viewer);
    viewer.setSAMProjectionCameraFrame({ fov: 30, cameraPosition: { x: 1, y: 12, z: 40 }, projection_zoom: 0.8 });
    w._samCameraModeActive = true;
    // Applying a SAM projection clears the orbit angles, as applySAM3DPoseData() does.
    w.exportParams.cam_yaw_deg = 0;
    w.exportParams.cam_pitch_deg = 0;
    w.applyCameraToViewer(true);
    w.syncCameraWidgets();
    assert.equal(findButton(scene, "Align Camera to View").disabled, true);
    moveEditor(viewer, { position: [0, 30, 30], target: [0, 10, 0], fov: 45 });
    assert.equal(w.alignCaptureCameraToView(), false);
    close(viewer.captureCamera.position.z, 40, 1e-9, "SAM owns the capture camera");
    w.clearSAMCameraMode();
    w.applyCameraToViewer(true);
    assertSameCamera(cameraState(viewer), aligned, "the aligned view returns after SAM");
    assert.equal(findButton(scene, "Align Camera to View").disabled, false);
});

test("Ctrl+Shift+F aligns only while Pose Studio has the interaction focus", () => {
    const scene = lensScene();
    const { w, viewer, context } = scene;
    const listeners = {};
    scene.document.addEventListener = (type, fn) => { listeners[type] = fn; };
    context.window.addEventListener = (type, fn) => { listeners[type] = fn; };
    const inside = new Element();
    const outside = new Element();
    w.container.contains = node => node === inside || node === w.container;
    w.container.isConnected = true;
    w.installCaptureViewShortcut();
    const press = values => {
        const event = { ctrlKey: true, shiftKey: true, altKey: false, metaKey: false, key: "F", code: "KeyF", target: inside,
            prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; }, ...values };
        listeners.keydown(event);
        return event;
    };
    moveEditor(viewer, editorView);

    let event = press({ target: scene.document.body });
    assert.equal(event.prevented, false, "no focus yet: the browser and ComfyUI keep the shortcut");
    assert.equal(w.exportParams.cam_view, null);
    listeners.pointerdown({ target: outside });
    assert.equal(press({ target: outside }).prevented, false);
    listeners.pointerdown({ target: inside });
    assert.equal(press({ ctrlKey: false }).prevented, false, "Shift+F alone is not the shortcut");
    assert.equal(press({ shiftKey: false }).prevented, false, "Ctrl+F stays the browser's find");
    assert.equal(press({ target: { ...inside, matches: () => true } }).prevented, false, "typing in a field is left alone");
    assert.equal(w.exportParams.cam_view, null);
    event = press({ key: "f" });
    assert.equal(event.prevented, true);
    assert.equal(event.stopped, true);
    assert.deepEqual(w.exportParams.cam_view.position, editorView.position);

    listeners.pointerdown({ target: outside });
    w.resetCaptureCamera();
    assert.equal(press({ target: outside }).prevented, false, "focus left Pose Studio");
    assert.equal(w.exportParams.cam_view, null);
    listeners.focusin({ target: inside });
    w.host = { embedded: true };
    assert.equal(press().prevented, false, "UniCanvas hides the camera controls and the shortcut");
});


test("adding a character copies the full capture lens of every existing tab", async () => {
    const scene = lensScene();
    const { w, viewer } = scene;
    const originalId = w.activeCharacterId;
    slide(scene, "cam_fov_deg", 50);
    slide(scene, "cam_distance", 80);
    w.exportWidgets.cam_maintain_subject_size.checked = true;
    w.exportWidgets.cam_maintain_subject_size.emit("change");
    w.alignCaptureCameraToView();
    const firstLens = w.currentCaptureLens();
    w.addTab();
    slide(scene, "cam_fov_deg", 70);
    slide(scene, "cam_distance", 30);
    const secondLens = w.currentCaptureLens();

    assert.equal(await w.addCharacter(), true);
    for (const character of w.characters) {
        assert.deepEqual(normalizeCaptureLens(character.poses[0].cameraParams), firstLens);
        assert.deepEqual(normalizeCaptureLens(character.poses[1].cameraParams), secondLens);
    }
    w.switchTab(0);
    assert.deepEqual(w.currentCaptureLens(), firstLens);
    assert.equal(viewer.captureCamera.fov, firstLens.fov_deg);
    await w.selectCharacter(originalId);
    assert.deepEqual(w.currentCaptureLens(), firstLens);
    assert.deepEqual(normalizeCaptureLens(w.poses[0].cameraParams), firstLens);
});

test("animation JSON export and import retain the capture lens and aligned composition", async () => {
    const source = lensScene();
    source.w.setEditorMode("animation");
    slide(source, "cam_fov_deg", 60);
    slide(source, "cam_distance", 80);
    source.w.exportWidgets.cam_maintain_subject_size.checked = true;
    source.w.exportWidgets.cam_maintain_subject_size.emit("change");
    source.viewer.camera.position.x += 5;
    source.viewer.orbit.update();
    source.w.alignCaptureCameraToView();
    const expectedLens = source.w.currentCaptureLens();
    const expectedCamera = cameraState(source.viewer);
    let exported;
    source.context.URL = {
        createObjectURL(blob) { exported = blob; return "blob:animation-export"; },
        revokeObjectURL: noop,
    };
    source.w.exportPose("animation", "Capture lens");
    const data = JSON.parse(await exported.text());
    assert.deepEqual(normalizeCaptureLens(data.camera), expectedLens);
    const target = lensScene();
    await target.w.loadCharacterSceneLibraryAsset(data, { animation: true });
    target.w.applyCameraToViewer(false);
    assert.deepEqual(target.w.currentCaptureLens(), expectedLens);
    assertSameCamera(cameraState(target.viewer), expectedCamera, "imported animation capture");
});

test("animation Undo and Redo restore lens gestures and Align without changing the clip", () => {
    const scene = lensScene();
    const { w, viewer } = scene;
    w.setEditorMode("animation");
    const clip = w.animationSnapshot();
    const start = cameraState(viewer);
    const fov = w.exportWidgets.cam_fov_deg;
    fov.emit("pointerdown");
    for (const value of [40, 50, 60]) {
        fov.value = String(value);
        fov.emit("input");
        assert.equal(viewer.captureCamera.fov, value);
    }
    fov.emit("change");
    fov.emit("pointerup");
    assert.equal(w._animationUndoStack.length, 1);
    w.undoAnimation();
    assertSameCamera(cameraState(viewer), start, "Undo FOV");
    assert.equal(fov._vnccsNumberInput.value, "30.00");
    close(viewer.camera.fov, 45);
    w.redoAnimation();
    assert.equal(viewer.captureCamera.fov, 60);
    slide(scene, "cam_distance", 80);
    w.undoAnimation();
    assert.equal(w.exportParams.cam_distance, 45);
    close(viewer.camera.position.distanceTo(viewer.orbit.target), 45);
    w.redoAnimation();
    assert.equal(w.exportParams.cam_distance, 80);
    const orbitCamera = cameraState(viewer);
    viewer.camera.position.x += 5;
    viewer.orbit.update();
    const editorPosition = viewer.camera.position.toArray();
    w.alignCaptureCameraToView();
    const alignedCamera = cameraState(viewer);
    w.undoAnimation();
    assertSameCamera(cameraState(viewer), orbitCamera, "Undo Align");
    assert.equal(w.exportParams.cam_view, null);
    assert.deepEqual(viewer.camera.position.toArray(), editorPosition);
    w.redoAnimation();
    assertSameCamera(cameraState(viewer), alignedCamera, "Redo Align");
    assert.deepEqual(viewer.camera.position.toArray(), editorPosition);
    assert.equal(w.animationSnapshot(), clip);
});


for (const mode of ["image", "animation"]) {
    test(`Reset Camera restores scene defaults and is undoable in ${mode} mode without moving characters`, () => {
        const scene = lensScene();
        const { w, viewer } = scene;
        const defaults = cameraState(viewer);
        Object.assign(w.exportParams, { cam_offset_x: 4, cam_offset_y: 2, cam_zoom: 1.3 });
        w.persistActivePoseCameraParams();
        w.setEditorMode(mode);
        const clip = w.animationSnapshot();
        const characters = sceneSnapshot(scene);
        for (const aligned of [false, true]) {
            slide(scene, "cam_yaw_deg", 25);
            slide(scene, "cam_pitch_deg", -15);
            slide(scene, "cam_fov_deg", 60);
            slide(scene, "cam_distance", 80);
            w.exportWidgets.cam_maintain_subject_size.checked = true;
            w.exportWidgets.cam_maintain_subject_size.emit("change");
            if (aligned) {
                moveEditor(viewer, editorView);
                w.alignCaptureCameraToView();
            }
            const previousCamera = cameraState(viewer);
            if (mode === "image") {
                viewer.history = [];
                viewer.future = [];
            } else w.resetAnimationHistory();
            const history = mode === "image" ? viewer.history : w._animationUndoStack;
            const depth = history.length;
            const reset = findButton(scene, "Reset Camera");
            assert.notEqual(reset.disabled, true);
            reset.click();
            assertSameCamera(cameraState(viewer), defaults, "Reset Camera");
            assert.deepEqual(w.currentCaptureLens(), normalizeCaptureLens());
            assert.equal(w.exportParams.cam_yaw_deg, 0);
            assert.equal(w.exportParams.cam_pitch_deg, 0);
            close(viewer.camera.fov, 45);
            assert.deepEqual(sceneSnapshot(scene), characters);
            assert.equal(history.length, depth + 1);
            if (mode === "image") viewer.undo();
            else w.undoAnimation();
            assertSameCamera(cameraState(viewer), previousCamera, "Undo Reset Camera");
            if (mode === "image") viewer.redo();
            else w.redoAnimation();
            assertSameCamera(cameraState(viewer), defaults, "Redo Reset Camera");
            assert.deepEqual(sceneSnapshot(scene), characters);
        }
        assert.equal(w.animationSnapshot(), clip);
    });
}

test("Reset Camera clears an applied SAM camera and restores the standard scene camera", () => {
    const scene = lensScene();
    const defaults = cameraState(scene.viewer);
    const characters = sceneSnapshot(scene);
    scene.w.applyLibrarySAMProjection({ fov: 35, cameraPosition: { x: 1, y: 12, z: 40 }, projection_zoom: 0.8 });
    findButton(scene, "Reset Camera").click();
    assert.equal(scene.viewer._samProjectionCameraFrame, null);
    assert.equal(scene.w._samCameraModeActive, false);
    assertSameCamera(cameraState(scene.viewer), defaults, "Reset SAM camera");
    assert.deepEqual(sceneSnapshot(scene), characters);
});
