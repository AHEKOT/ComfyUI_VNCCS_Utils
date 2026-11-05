import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "../web/vendor/three/three.module.js";
import { TransformControls } from "../web/vendor/three/TransformControls.js";
import { createScene, Element } from "./helpers/pose_studio_scene.mjs";
import { normalizeCharacterTransform } from "../web/pose_studio/characters.mjs";
import {
    CHARACTER_POSITION_LIMITS,
    MODEL_ROTATION_ORDER,
    clampCharacterPosition,
    modelRotationQuaternion,
    normalizeCharacterTransformMode,
    quaternionToModelRotation,
    rotateCharacterAboutPivot,
    setCharacterRotationAboutPivot,
    translateCharacterPosition,
    wrapDegrees,
} from "../web/pose_studio/character_transform.mjs";
import {
    CHARACTER_GIZMO_EDITOR_LAYER,
    PoseCharacterTransformController,
} from "../web/pose_studio/character_transform_controller.mjs";

const close = (actual, expected, message = "", epsilon = 1e-6) => assert.ok(
    Math.abs(actual - expected) < epsilon,
    `${message}: ${actual} vs ${expected}`,
);
const closeVector = (actual, expected, message = "", epsilon = 1e-5) => {
    for (const axis of ["x", "y", "z"]) close(actual[axis], expected[axis], `${message} ${axis}`, epsilon);
};

function gizmoScene() {
    const scene = createScene({ skinned: true });
    const { w, viewer } = scene;
    viewer.TransformControls = TransformControls;
    viewer._initIKHelpers();
    viewer.transform = new TransformControls(viewer.camera, viewer.canvas);
    viewer.scene.add(viewer.transform);
    viewer.camera.position.set(0, 0, 40);
    viewer.camera.lookAt(0, 0, 0);
    viewer.camera.updateMatrixWorld(true);
    let orbitEnabled = true;
    Object.defineProperty(viewer.orbit, "enabled", {
        get: () => orbitEnabled,
        set: value => { scene.orbitChanges.push(value); orbitEnabled = value; },
    });
    scene.orbitChanges = [];
    const controller = new PoseCharacterTransformController(w, { document: scene.document });
    w.characterTransform = controller;
    controller.attach(viewer, null);
    assert.equal(controller.onViewerReady(), true);
    const panel = new Element();
    controller.renderPanel(panel);
    scene.controller = controller;
    scene.panel = panel;
    scene.syncs = 0;
    const sync = w.syncToNode;
    w.syncToNode = (...args) => { scene.syncs++; return sync.apply(w, args); };
    return scene;
}

const frame = scene => scene.viewer.scene.updateMatrixWorld(true);
const pelvisWorld = scene => scene.controller.pivotBone().getWorldPosition(new THREE.Vector3());
const localPose = scene => JSON.stringify({
    bones: scene.viewer.getPose().bones,
    bonePositions: scene.viewer.getPose().bonePositions,
    hipBonePosition: scene.viewer.getPose().hipBonePosition,
});
const fieldValues = scene => {
    const inputs = scene.controller.fields.inputs;
    return {
        position: ["x", "y", "z"].map(axis => Number(inputs.position[axis].value)),
        rotation: ["x", "y", "z"].map(axis => Number(inputs.rotation[axis].value)),
    };
};
const savedActive = scene => {
    const data = JSON.parse(scene.node.widgets[0].value);
    return data.characters.find(character => character.id === data.active_character_id);
};

/** Find a pointer position (NDC) whose hover selects the requested handle. */
function findHandle(scene, axis) {
    const { gizmo } = scene.controller;
    frame(scene);
    let best = null;
    for (let i = -60; i <= 60; i += 1) {
        for (let j = -60; j <= 60; j += 1) {
            const pointer = { x: i / 60, y: j / 60, button: 0 };
            gizmo.pointerHover(pointer);
            if (gizmo.axis !== axis) continue;
            const radius = Math.hypot(pointer.x, pointer.y);
            if (!best || radius > best.radius) best = { ...pointer, radius };
        }
    }
    gizmo.pointerHover({ x: 2, y: 2, button: 0 });
    assert.ok(best, `gizmo handle ${axis} is reachable`);
    return best;
}

/** Real TransformControls drag through its pointer API, one frame per step. */
function drag(scene, axis, steps, { onStep } = {}) {
    const { gizmo } = scene.controller;
    const start = findHandle(scene, axis);
    gizmo.pointerHover(start);
    gizmo.pointerDown(start);
    assert.equal(gizmo.dragging, true, `${axis} drag starts`);
    for (const [dx, dy] of steps) {
        gizmo.pointerMove({ x: start.x + dx, y: start.y + dy, button: -1 });
        frame(scene);
        onStep?.();
    }
    const [dx, dy] = steps.at(-1);
    gizmo.pointerUp({ x: start.x + dx, y: start.y + dy, button: 0 });
    frame(scene);
}

test("pure mapping: limits, Euler order, continuity and pivot math", () => {
    assert.equal(MODEL_ROTATION_ORDER, "XYZ");
    assert.equal(normalizeCharacterTransformMode("bogus"), "pose");
    for (const value of [-999, -60, -50, -40, 0, 40, 50, 60, 999]) {
        const fromCharacters = normalizeCharacterTransform({ x: value, y: value, z: value });
        assert.deepEqual(clampCharacterPosition({ x: value, y: value, z: value }),
            { x: fromCharacters.x, y: fromCharacters.y, z: fromCharacters.z });
    }
    assert.deepEqual(CHARACTER_POSITION_LIMITS.z, [-40, 40]);
    assert.equal(wrapDegrees(190), -170);
    assert.equal(wrapDegrees(-180), 180);

    // A full turn about Y stays continuous instead of flipping X / Z by 180.
    let previous = { x: 0, y: 0, z: 0 };
    for (let yaw = 0; yaw <= 360; yaw += 15) {
        const q = modelRotationQuaternion(THREE, { x: 0, y: yaw, z: 0 });
        const next = quaternionToModelRotation(THREE, q, previous);
        close(next.x, 0, `yaw ${yaw} x`); close(next.z, 0, `yaw ${yaw} z`);
        close(next.y, wrapDegrees(yaw), `yaw ${yaw} y`);
        previous = next;
    }
    // Decomposition reproduces the quaternion for arbitrary orientations.
    for (const rotation of [{ x: 30, y: 120, z: -45 }, { x: -170, y: 80, z: 10 }, { x: 5, y: -95, z: 175 }]) {
        const q = modelRotationQuaternion(THREE, rotation);
        const back = modelRotationQuaternion(THREE, quaternionToModelRotation(THREE, q, rotation));
        assert.ok(Math.abs(q.dot(back)) > 1 - 1e-9, JSON.stringify(rotation));
    }

    // Rotating about the pivot leaves the pivot fixed in world space.
    const position = { x: 3, y: -2, z: 5 };
    const rotation = { x: 10, y: 20, z: 0 };
    const pivotLocal = new THREE.Vector3(0.2, -0.7, 0.1);
    const world = (pos, rot) => pivotLocal.clone().applyQuaternion(modelRotationQuaternion(THREE, rot))
        .add(new THREE.Vector3(pos.x, pos.y, pos.z));
    const pivot = world(position, rotation);
    const delta = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 1, 0).normalize(), 1.1);
    const rotated = rotateCharacterAboutPivot(THREE, { position, rotation, pivot, delta });
    closeVector(world(rotated.position, rotated.rotation), pivot, "pivot stays");
    const back = setCharacterRotationAboutPivot(THREE, {
        position: rotated.position, rotation: rotated.rotation, pivot, nextRotation: rotation,
    });
    closeVector(back.position, position, "rotation round trip restores the placement");
    assert.deepEqual(back.rotation, rotation);
    assert.deepEqual(translateCharacterPosition({ x: 49, y: 0, z: -39 }, { x: 5, y: 1, z: -5 }), { x: 50, y: 1, z: -40 });
});

test("Pose is the default; Move / Rotate attach the gizmo at the pelvis and release bone input", () => {
    const scene = gizmoScene();
    const { controller, viewer } = scene;
    assert.equal(controller.mode, "pose");
    assert.equal(controller.gizmo.object, undefined);
    assert.equal(controller.gizmo.enabled, false);
    assert.equal(controller.suppressesBoneInput(), false);

    viewer.selectBone(viewer.bones.upperarm01_l || viewer.boneList[5]);
    assert.ok(viewer.transform.object, "a bone is selected in Pose mode");
    controller.setMode("move");
    assert.equal(viewer.selectedBone, null);
    assert.equal(viewer.transform.object, undefined);
    assert.equal(controller.gizmo.object, controller.proxy);
    assert.equal(controller.gizmo.mode, "translate");
    assert.equal(controller.gizmo.enabled, true);
    frame(scene);
    closeVector(controller.proxy.position, pelvisWorld(scene), "gizmo at pelvis");
    assert.equal(controller.handleViewerPointerDown({ clientX: 1, clientY: 1, pointerId: 1 }), true);

    controller.setMode("rotate");
    assert.equal(controller.gizmo.mode, "rotate");
    controller.setSpace("local");
    assert.equal(controller.gizmo.space, "local");
    controller.setMode("pose");
    assert.equal(controller.gizmo.object, undefined);
    assert.equal(controller.handleViewerPointerDown({ clientX: 1, clientY: 1, pointerId: 1 }), false);

    // The gizmo is drawn only for the editor camera, never the capture camera.
    let visual = 0;
    controller.gizmo._gizmo.gizmo.translate.traverse(object => {
        if (object.isMesh || object.isLine) {
            visual++;
            assert.equal(object.layers.mask, 1 << CHARACTER_GIZMO_EDITOR_LAYER);
        }
    });
    assert.ok(visual > 0);
    assert.ok(viewer.camera.layers.isEnabled(CHARACTER_GIZMO_EDITOR_LAYER));
    assert.equal(viewer.captureCamera.layers.isEnabled(CHARACTER_GIZMO_EDITOR_LAYER), false);
});

test("Move gizmo drags update state, fields and Radar data live; one undo per drag", () => {
    const scene = gizmoScene();
    const { w, viewer, controller } = scene;
    const pose = localPose(scene);
    controller.setMode("move");
    const history = viewer.history.length;
    const seen = [];
    drag(scene, "X", [[0.05, 0], [0.12, 0], [0.2, 0]], {
        onStep: () => {
            const x = w.getActiveCharacter().transform.x;
            seen.push(x);
            assert.equal(scene.orbitChanges.at(-1), false, "camera orbit is suppressed during the drag");
            close(viewer.skinnedMesh.position.x, x, "mesh follows");
            close(w.exportParams.cam_offset_x, x, "Radar source follows");
            close(w.poses[w.activeTab].cameraParams.offset_x, x, "pose framing follows");
            close(fieldValues(scene).position[0], Number(x.toFixed(2)), "field follows during the drag");
            closeVector(controller.proxy.position, pelvisWorld(scene), "gizmo follows");
        },
    });
    assert.ok(seen[0] > 0 && seen[1] > seen[0] && seen[2] > seen[1], `continuous X ${seen}`);
    assert.equal(scene.orbitChanges.at(-1), true);
    assert.equal(viewer.history.length, history + 1, "one undo entry for the drag");
    assert.equal(scene.syncs, 1, "one commit at drag end");
    assert.equal(localPose(scene), pose, "joint local poses are unchanged");
    close(savedActive(scene).transform.x, seen.at(-1), "saved x");
    close(w.getActiveCharacter().transform.y, 0, "y unchanged");
    close(w.getActiveCharacter().transform.z, 0, "z unchanged");

    // Plane and free (camera-plane) drags.
    drag(scene, "XY", [[0.05, 0.05], [0.1, 0.1]]);
    const afterPlane = { ...w.getActiveCharacter().transform };
    assert.ok(afterPlane.y > 0.1, "XY plane moves Y");
    close(afterPlane.z, 0, "XY plane keeps Z");
    drag(scene, "XYZ", [[-0.05, -0.02], [-0.1, -0.04]]);
    assert.ok(w.getActiveCharacter().transform.x < afterPlane.x, "free drag moves in the camera plane");
    assert.equal(viewer.history.length, history + 3);

    viewer.undo();
    closeVector(w.getActiveCharacter().transform, afterPlane, "undo restores the plane result");
    viewer.undo();
    viewer.undo();
    closeVector(w.getActiveCharacter().transform, { x: 0, y: 0, z: 0 }, "undo restores the start");
    close(viewer.skinnedMesh.position.x, 0, "mesh undone");
    frame(scene);
    closeVector(controller.proxy.position, pelvisWorld(scene), "gizmo follows undo");
    controller.syncFields();
    assert.deepEqual(fieldValues(scene).position, [0, 0, 0]);
    viewer.redo();
    close(w.getActiveCharacter().transform.x, seen.at(-1), "redo");
});

test("Move along Z changes depth, persists, and survives a tab switch", () => {
    const scene = gizmoScene();
    const { w, controller } = scene;
    // Look from the side so the Z arrow has screen extent.
    scene.viewer.camera.position.set(40, 0, 0.01);
    scene.viewer.camera.lookAt(0, 0, 0);
    scene.viewer.camera.updateMatrixWorld(true);
    controller.setMode("move");
    drag(scene, "Z", [[0.05, 0], [0.1, 0]]);
    const z = w.getActiveCharacter().transform.z;
    assert.ok(Math.abs(z) > 0.5, `z moved ${z}`);
    close(scene.viewer.skinnedMesh.position.z, z, "mesh depth");
    close(savedActive(scene).transform.z, z, "saved depth");
    w.restoreActivePoseCameraParams();
    close(w.getActiveCharacter().transform.z, z, "restoring the pose camera keeps depth");
});

test("Rotate rings keep the pelvis fixed and joint poses unchanged; World and Local", () => {
    const scene = gizmoScene();
    const { w, viewer, controller } = scene;
    const pose = localPose(scene);
    const pivot = pelvisWorld(scene);
    const effector = viewer.ikController.effectors[Object.keys(viewer.ikController.effectors).find(name => /hand/i.test(name))];
    const pole = Object.values(viewer.ikController.poleTargets)[0];
    const poleOffset = pole.position.clone().sub(pivot);
    controller.setMode("rotate");
    const history = viewer.history.length;
    const yaw = [];
    drag(scene, "Y", [[0.04, 0], [0.09, 0], [0.15, 0]], {
        onStep: () => {
            yaw.push(viewer.modelRotation.y);
            closeVector(pelvisWorld(scene), pivot, "pelvis stays during rotation");
            close(fieldValues(scene).rotation[1], Number(viewer.modelRotation.y.toFixed(1)), "rotation field follows");
            const bone = viewer.bones[effector.userData.effectorName];
            closeVector(effector.position, bone.getWorldPosition(new THREE.Vector3()), "IK effector follows its bone");
            const expected = poleOffset.clone().applyQuaternion(viewer.skinnedMesh.quaternion).add(pivot);
            closeVector(pole.position, expected, "IK pole target follows the character", 1e-4);
        },
    });
    assert.ok(Math.abs(yaw[2]) > Math.abs(yaw[0]) && Math.abs(yaw[0]) > 0, `continuous yaw ${yaw}`);
    close(viewer.modelRotation.x, 0, "x untouched", 1e-6);
    close(viewer.modelRotation.z, 0, "z untouched", 1e-6);
    assert.equal(viewer.history.length, history + 1);
    assert.equal(localPose(scene), pose, "bone local poses are unchanged");
    assert.deepEqual(savedActive(scene).poses[w.activeTab].modelRotation.map(v => Number(v.toFixed(6))),
        [viewer.modelRotation.x, viewer.modelRotation.y, viewer.modelRotation.z].map(v => Number(v.toFixed(6))));

    // Local X ring after a yaw tilts about the character's own X axis.
    controller.setSpace("local");
    const before = viewer.skinnedMesh.quaternion.clone();
    drag(scene, "X", [[0, 0.05], [0, 0.1]]);
    closeVector(pelvisWorld(scene), pivot, "pelvis stays in Local space");
    const deltaLocal = before.clone().invert().multiply(viewer.skinnedMesh.quaternion);
    const axis = new THREE.Vector3(deltaLocal.x, deltaLocal.y, deltaLocal.z).normalize();
    close(Math.abs(axis.x), 1, "local delta is about the character X axis", 1e-4);
    assert.equal(localPose(scene), pose);
    viewer.undo();
    viewer.undo();
    closeVector(viewer.skinnedMesh.quaternion, new THREE.Quaternion(), "undo returns to the start");
    closeVector(pelvisWorld(scene), pivot, "undo returns the pelvis");
});

test("Fields drive the character live and the gizmo follows; Reset buttons", () => {
    const scene = gizmoScene();
    const { w, viewer, controller } = scene;
    controller.setMode("move");
    const inputs = controller.fields.inputs;
    const history = viewer.history.length;
    for (const value of ["1", "12", "12.5"]) {
        inputs.position.x.value = value;
        inputs.position.x.emit("input");
        close(viewer.skinnedMesh.position.x, Number(value), "live while typing");
    }
    inputs.position.x.emit("change");
    assert.equal(viewer.history.length, history + 1, "one undo per field edit");
    frame(scene);
    closeVector(controller.proxy.position, pelvisWorld(scene), "gizmo follows the field");
    close(w.exportParams.cam_offset_x, 12.5, "Radar source");
    inputs.position.z.value = "-60";
    inputs.position.z.emit("input");
    inputs.position.z.emit("change");
    close(w.getActiveCharacter().transform.z, -40, "z is clamped to the stored range");
    assert.equal(inputs.position.z.value, "-40");

    const pivot = pelvisWorld(scene);
    inputs.rotation.y.value = "90";
    inputs.rotation.y.emit("input");
    inputs.rotation.y.emit("blur");
    close(viewer.modelRotation.y, 90, "rotation field");
    closeVector(pelvisWorld(scene), pivot, "rotation field pivots about the pelvis");
    inputs.rotation.x.value = "30";
    inputs.rotation.x.emit("input");
    inputs.rotation.x.emit("change");
    assert.equal(viewer.history.length, history + 4);

    // External edits (Model Rotation slider path) refresh the fields on render.
    viewer.setModelRotation(undefined, 45, undefined);
    controller.onViewportRender();
    assert.equal(inputs.rotation.y.value, "45");

    const beforeReset = viewer.history.length;
    const resetPivot = pelvisWorld(scene);
    assert.equal(controller.resetRotation(), true);
    assert.deepEqual([viewer.modelRotation.x, viewer.modelRotation.y, viewer.modelRotation.z], [0, 0, 0]);
    closeVector(pelvisWorld(scene), resetPivot, "Reset Rotation keeps the pelvis in place", 1e-4);
    assert.equal(controller.resetPosition(), true);
    closeVector(w.getActiveCharacter().transform, { x: 0, y: 0, z: 0 }, "Reset Position");
    assert.equal(w.getActiveCharacter().transform.zoom, 1, "zoom untouched");
    assert.equal(viewer.history.length, beforeReset + 2);
    assert.deepEqual(fieldValues(scene), { position: [0, 0, 0], rotation: [0, 0, 0] });
});

test("Workflow round trip restores position and rotation; saved schema is unchanged", () => {
    const scene = gizmoScene();
    const { w, viewer, controller, node } = scene;
    const keysBefore = Object.keys(JSON.parse(node.widgets[0].value)).sort();
    const characterKeysBefore = Object.keys(savedActive(scene)).sort();
    controller.setMode("move");
    const inputs = controller.fields.inputs;
    for (const [kind, axis, value] of [["position", "x", "4"], ["position", "y", "-3"], ["position", "z", "7"], ["rotation", "y", "135"]]) {
        inputs[kind][axis].value = value;
        inputs[kind][axis].emit("input");
        inputs[kind][axis].emit("change");
    }
    const transform = { ...w.getActiveCharacter().transform };
    const rotation = { ...viewer.modelRotation };
    const raw = node.widgets[0].value;
    assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), keysBefore);
    assert.deepEqual(Object.keys(savedActive(scene)).sort(), characterKeysBefore);
    assert.equal(/"mode"|gizmo/i.test(raw), false, "viewport mode is UI state, not saved");

    const restored = gizmoScene();
    restored.w.hydrateCharacterSceneModels = async () => {};
    restored.node.widgets[0].value = raw;
    restored.w.loadFromNode();
    restored.w.updateCharacterScene();
    closeVector(restored.w.getActiveCharacter().transform, transform, "transform restored");
    closeVector(restored.viewer.skinnedMesh.position, transform, "mesh placement restored");
    closeVector(restored.viewer.modelRotation, rotation, "rotation restored");
    restored.controller.syncFields(true);
    assert.deepEqual(fieldValues(restored), {
        position: [transform.x, transform.y, transform.z].map(v => Number(v.toFixed(2))),
        rotation: [rotation.x, rotation.y, rotation.z].map(v => Number(v.toFixed(1))),
    });
    assert.equal(restored.controller.mode, "pose", "a restored workflow opens in Pose mode");

    // Old data without depth loads exactly as before.
    const legacy = JSON.parse(raw);
    for (const character of legacy.characters) delete character.transform.z;
    const old = gizmoScene();
    old.w.hydrateCharacterSceneModels = async () => {};
    old.node.widgets[0].value = JSON.stringify(legacy);
    old.w.loadFromNode();
    assert.equal(old.w.getActiveCharacter().transform.z, 0);
    close(old.w.getActiveCharacter().transform.x, transform.x, "legacy x");
});

test("Pose Library save and load restore the character position and rotation", async () => {
    const scene = gizmoScene();
    const { w, viewer, controller } = scene;
    controller.setMode("move");
    controller.applyPlacement({ position: { x: -6, y: 2, z: 9 }, rotation: { x: 0, y: -120, z: 15 } });
    controller.commit();
    let saved = null;
    w.saveLibraryPoseRecord = async payload => { saved = payload; return { id: "local_user_poses/Uncategorized/gizmo" }; };
    w.refreshLibrary = async () => {};
    assert.equal(await w.saveToLibrary("gizmo", false), true);
    const savedCharacter = saved.pose.characters.find(character => character.id === saved.pose.active_character_id);
    closeVector(savedCharacter.transform, { x: -6, y: 2, z: 9 }, "library transform");
    assert.deepEqual(savedCharacter.poses[0].modelRotation.map(v => Number(v.toFixed(6))), [0, -120, 15]);

    const target = gizmoScene();
    target.context.fetch = async () => ({ ok: true, json: async () => ({ pose: JSON.parse(JSON.stringify(saved.pose)) }) });
    await target.w.loadFromLibrary("local_user_poses/Uncategorized/gizmo");
    closeVector(target.w.getActiveCharacter().transform, { x: -6, y: 2, z: 9 }, "library load transform");
    closeVector(target.viewer.modelRotation, { x: 0, y: -120, z: 15 }, "library load rotation");
    target.controller.onViewportRender();
    assert.deepEqual(fieldValues(target), { position: [-6, 2, 9], rotation: [0, -120, 15] });
    assert.equal(target.viewer.history.length, 1, "loading a library pose is one undo step");
});

test("Characters keep independent positions and rotations; the gizmo follows the selection", async () => {
    const scene = gizmoScene();
    const { w, viewer, controller } = scene;
    const first = w.getActiveCharacter().id;
    controller.setMode("rotate");
    controller.applyPlacement({ position: { x: -5, y: 0, z: 2 }, rotation: { x: 0, y: 90, z: 0 } });
    controller.commit();
    assert.equal(await w.addCharacter(), true);
    const second = w.getActiveCharacter().id;
    assert.notEqual(second, first);
    assert.deepEqual([viewer.modelRotation.x, viewer.modelRotation.y, viewer.modelRotation.z], [0, 0, 0],
        "the new character does not inherit the first character's rotation");
    controller.applyPlacement({ position: { x: 5, y: 1, z: -3 }, rotation: { x: 0, y: -90, z: 0 } });
    controller.commit();
    frame(scene);
    closeVector(controller.proxy.position, pelvisWorld(scene), "gizmo on the selected character");

    const firstCharacter = w.characters.find(character => character.id === first);
    closeVector(firstCharacter.transform, { x: -5, y: 0, z: 2 }, "first character untouched");
    assert.equal(firstCharacter.poses[w.activeTab].modelRotation[1], 90);
    const passive = viewer.passiveCharacters.get(first).mesh;
    closeVector(passive.position, { x: -5, y: 0, z: 2 }, "passive mesh placement");
    close(passive.rotation.y, Math.PI / 2, "passive mesh rotation");

    assert.equal(await w.selectCharacter(first), true);
    closeVector(w.getActiveCharacter().transform, { x: -5, y: 0, z: 2 }, "first restored");
    close(viewer.modelRotation.y, 90, "first rotation restored");
    controller.onViewportRender();
    assert.deepEqual(fieldValues(scene), { position: [-5, 0, 2], rotation: [0, 90, 0] });
    frame(scene);
    closeVector(controller.proxy.position, pelvisWorld(scene), "gizmo moved to the first character");
    const secondCharacter = w.characters.find(character => character.id === second);
    closeVector(secondCharacter.transform, { x: 5, y: 1, z: -3 }, "second untouched by the switch");
    assert.equal(secondCharacter.poses[w.activeTab].modelRotation[1], -90);
    assert.equal(controller.mode, "rotate", "the edit mode stays while switching characters");
});

test("Clicking a character in Move / Rotate mode selects it without touching bones", async () => {
    const scene = gizmoScene();
    const { w, viewer, controller } = scene;
    const first = w.getActiveCharacter().id;
    assert.equal(await w.addCharacter(), true);
    const second = w.getActiveCharacter().id;
    controller.applyPlacement({ position: { x: 8, y: 0, z: 0 } });
    controller.commit();
    viewer.camera.position.set(4, 0, 45);
    viewer.camera.lookAt(4, 0, 0);
    viewer.camera.updateMatrixWorld(true);
    // The test canvas is 140 x 140 at the origin; aim at the first character's chest.
    const project = point => {
        const ndc = point.clone().project(viewer.camera);
        return { clientX: (ndc.x + 1) * 70, clientY: (1 - ndc.y) * 70, pointerId: 1, type: "pointerup" };
    };
    const chest = viewer.passiveCharacters.get(first).mesh.localToWorld(new THREE.Vector3(0, 2, 0));
    assert.equal(controller.characterIdAt(project(chest)), first);
    controller.setMode("move");
    const event = project(chest);
    assert.equal(controller.handleViewerPointerDown(event), true);
    let selected = null;
    w.selectCharacter = async id => { selected = id; return true; };
    controller.handleCanvasPointerUp(event);
    assert.equal(selected, first);
    // A drag (orbit) is not a click.
    controller.handleViewerPointerDown(event);
    selected = null;
    controller.handleCanvasPointerUp({ ...event, clientX: event.clientX + 20 });
    assert.equal(selected, null);
    assert.equal(viewer.selectedBone, null);
    assert.equal(w.getActiveCharacter().id, second);
});

/** Project a world point to the test canvas (140 x 140 at the origin). */
const clientPoint = (scene, point) => {
    const ndc = point.clone().project(scene.viewer.camera);
    return { clientX: (ndc.x + 1) * 70, clientY: (1 - ndc.y) * 70, pointerId: 1, type: "pointerup" };
};
const click = (controller, event) => {
    controller.handleCanvasPointerDown(event);
    assert.equal(controller.handleViewerPointerDown(event), true);
    controller.handleCanvasPointerUp(event);
};
/** Press a handle and stop, optionally with pointer moves that do not change the placement. */
function pressHandle(scene, axis, { stationaryMoves = 0 } = {}) {
    const { gizmo } = scene.controller;
    const start = findHandle(scene, axis);
    scene.controller.handleCanvasPointerDown({ pointerId: 1 });
    gizmo.pointerHover(start);
    gizmo.pointerDown(start);
    assert.equal(gizmo.dragging, true, `${axis} drag starts`);
    for (let i = 0; i < stationaryMoves; i += 1) {
        gizmo.pointerMove({ x: start.x, y: start.y, button: -1 });
        frame(scene);
    }
    return start;
}
const OFF_CHARACTER = { clientX: 3, clientY: 3, pointerId: 1, type: "pointerup" };

test("A click on empty space hides the gizmo; a click on a character shows it again", async () => {
    const scene = gizmoScene();
    const { w, viewer, controller } = scene;
    const first = w.getActiveCharacter().id;
    assert.equal(await w.addCharacter(), true);
    const second = w.getActiveCharacter().id;
    controller.applyPlacement({ position: { x: 8, y: 0, z: 0 } });
    controller.commit();
    viewer.camera.position.set(4, 0, 45);
    viewer.camera.lookAt(4, 0, 0);
    viewer.camera.updateMatrixWorld(true);
    w.selectCharacter = async id => { scene.selected = id; return true; };

    controller.setMode("move");
    assert.equal(controller.gizmo.object, controller.proxy);
    assert.equal(controller.characterIdAt(OFF_CHARACTER), null, "the corner is empty");
    const history = viewer.history.length;
    const orbit = scene.orbitChanges.length;

    // An orbit drag starting on empty space keeps the selection.
    controller.handleCanvasPointerDown(OFF_CHARACTER);
    controller.handleViewerPointerDown(OFF_CHARACTER);
    controller.handleCanvasPointerUp({ ...OFF_CHARACTER, clientX: OFF_CHARACTER.clientX + 20 });
    assert.equal(controller.gizmo.object, controller.proxy, "an orbit drag is not a click");

    click(controller, OFF_CHARACTER);
    assert.equal(controller.gizmo.object, undefined, "the gizmo is detached");
    assert.equal(controller.gizmo.visible, false, "and hidden");
    assert.equal(w.getActiveCharacter().id, second, "the panel keeps its active character");
    assert.equal(viewer.history.length, history, "deselecting is not an edit");
    assert.equal(scene.orbitChanges.length, orbit, "orbit is never switched off by a click");

    // A hidden gizmo stays hidden across renders and takes no input.
    frame(scene);
    controller.onViewportRender();
    assert.equal(controller.gizmo.object, undefined);
    controller.gizmo.pointerHover({ x: 0, y: 0, button: 0 });
    assert.equal(controller.gizmo.axis, null);

    // Clicking the same character brings it back.
    const activeChest = viewer.skinnedMesh.localToWorld(new THREE.Vector3(0, 2, 0));
    click(controller, clientPoint(scene, activeChest));
    assert.equal(controller.gizmo.object, controller.proxy, "the active character shows its gizmo again");
    assert.equal(scene.selected, undefined, "the active character is not re-selected");

    // Clicking another character selects it and shows the gizmo.
    click(controller, OFF_CHARACTER);
    const otherChest = viewer.passiveCharacters.get(first).mesh.localToWorld(new THREE.Vector3(0, 2, 0));
    click(controller, clientPoint(scene, otherChest));
    assert.equal(scene.selected, first);
    assert.equal(controller.gizmo.object, controller.proxy);

    // Selecting from the panel while the gizmo is hidden shows it on that character.
    click(controller, OFF_CHARACTER);
    assert.equal(controller.gizmo.object, undefined);
    delete w.selectCharacter;
    assert.equal(await w.selectCharacter(first), true);
    controller.onViewportRender();
    assert.equal(controller.gizmo.object, controller.proxy, "a panel selection shows the gizmo");

    // Switching mode shows it as well.
    click(controller, OFF_CHARACTER);
    controller.setMode("rotate");
    assert.equal(controller.gizmo.object, controller.proxy, "a mode switch shows the gizmo");
    click(controller, OFF_CHARACTER);
    controller.setMode("rotate");
    assert.equal(controller.gizmo.object, controller.proxy, "the active mode button shows the gizmo");
    click(controller, OFF_CHARACTER);
    controller.setMode("pose");
    assert.equal(controller.gizmo.object, undefined);
    controller.setMode("move");
    assert.equal(controller.gizmo.object, controller.proxy, "returning from Pose shows the gizmo");
});

for (const [mode, axis] of [["move", "X"], ["rotate", "Y"]]) {
    test(`A ${mode} handle click without movement keeps Undo and Redo`, () => {
        const scene = gizmoScene();
        const { w, viewer, controller } = scene;
        controller.setMode(mode);
        const steps = mode === "move" ? [[0.05, 0], [0.1, 0]] : [[0.05, 0.05], [0.1, 0.1]];
        drag(scene, axis, steps);
        viewer.undo();
        frame(scene);
        assert.equal(viewer.future.length, 1, "the drag can be redone");
        const history = viewer.history.slice();
        const future = viewer.future.slice();
        const syncs = scene.syncs;

        for (const stationaryMoves of [0, 3]) {
            const start = pressHandle(scene, axis, { stationaryMoves });
            controller.gizmo.pointerUp({ ...start, button: 0 });
            frame(scene);
            assert.deepEqual(viewer.history, history, `no undo entry (${stationaryMoves} moves)`);
            assert.deepEqual(viewer.future, future, `Redo survives (${stationaryMoves} moves)`);
            assert.equal(scene.syncs, syncs, "nothing is committed");
            assert.equal(scene.orbitChanges.at(-1), true, "orbit is back");
        }

        const undone = JSON.stringify([w.exportParams.cam_offset_x, viewer.modelRotation]);
        viewer.redo();
        assert.notEqual(JSON.stringify([w.exportParams.cam_offset_x, viewer.modelRotation]), undone, "Redo still applies the drag");
    });
}

test("Fields and Reset buttons that change nothing keep Undo and Redo", () => {
    const scene = gizmoScene();
    const { viewer, controller } = scene;
    controller.setMode("move");
    drag(scene, "X", [[0.05, 0], [0.1, 0]]);
    viewer.undo();
    frame(scene);
    const history = viewer.history.slice();
    const future = viewer.future.slice();
    assert.equal(controller.resetPosition(), false);
    assert.equal(controller.resetRotation(), false);
    controller.handleFieldInput("position", "x", "0");
    controller.handleFieldInput("rotation", "y", "360");
    controller.finishFieldEdit();
    assert.deepEqual(viewer.history, history);
    assert.deepEqual(viewer.future, future);
});

test("A full Undo history loses nothing to a no-op click and one entry to a real drag", () => {
    const scene = gizmoScene();
    const { viewer, controller } = scene;
    controller.setMode("move");
    for (let i = 0; i < viewer.maxHistory + 2; i += 1) drag(scene, "X", [[0.02, 0], [0.04, 0]]);
    assert.equal(viewer.history.length, viewer.maxHistory, "history is full");
    const history = viewer.history.slice();

    const start = pressHandle(scene, "X", { stationaryMoves: 2 });
    controller.gizmo.pointerUp({ ...start, button: 0 });
    frame(scene);
    assert.deepEqual(viewer.history, history, "the oldest entry survives a no-op click");

    drag(scene, "X", [[0.02, 0], [0.04, 0]]);
    assert.equal(viewer.history.length, viewer.maxHistory);
    assert.deepEqual(viewer.history.slice(0, -1), history.slice(1), "a real drag drops only the oldest entry");
});

for (const type of ["pointercancel", "lostpointercapture"]) {
    test(`${type} ends a drag: one undo step, orbit restored, widget usable`, () => {
        const scene = gizmoScene();
        const { w, viewer, controller } = scene;
        controller.setMode("move");
        const history = viewer.history.length;
        const start = pressHandle(scene, "X");
        const seen = [];
        for (const dx of [0.05, 0.1, 0.15]) {
            controller.gizmo.pointerMove({ x: start.x + dx, y: start.y, button: -1 });
            frame(scene);
            seen.push(w.getActiveCharacter().transform.x);
            assert.equal(viewer.isInteractionActive, true);
            assert.equal(scene.orbitChanges.at(-1), false);
        }
        assert.ok(seen[0] > 0 && seen[1] > seen[0] && seen[2] > seen[1], `continuous X ${seen}`);

        // Another pointer's event does not end this drag.
        viewer.canvas.emit(type, { pointerId: 2 });
        assert.equal(controller.gizmo.dragging, true, "a second pointer is ignored");

        viewer.canvas.emit(type, { pointerId: 1 });
        assert.equal(controller.gizmo.dragging, false);
        assert.equal(controller.gizmo.axis, null);
        assert.equal(controller._drag, null);
        assert.equal(viewer.isInteractionActive, false);
        assert.equal(scene.orbitChanges.at(-1), true, "orbit is back");
        assert.equal(viewer.history.length, history + 1, "one undo step");
        assert.equal(scene.syncs, 1, "one commit");
        close(w.getActiveCharacter().transform.x, seen.at(-1), "the character stays where it was last shown");

        // A late event of the same gesture changes nothing, and stray moves do not edit.
        viewer.canvas.emit(type === "pointercancel" ? "lostpointercapture" : "pointercancel", { pointerId: 1 });
        controller.gizmo.pointerMove({ x: start.x + 0.4, y: start.y, button: -1 });
        assert.equal(scene.syncs, 1);
        close(w.getActiveCharacter().transform.x, seen.at(-1), "no edit after the gesture ended");

        // The widget stays usable.
        drag(scene, "X", [[0.05, 0], [0.1, 0]]);
        assert.ok(w.getActiveCharacter().transform.x > seen.at(-1), "the next drag works");
        assert.equal(viewer.history.length, history + 2);
        viewer.undo();
        close(w.getActiveCharacter().transform.x, seen.at(-1), "Undo returns to the interrupted result");
        viewer.undo();
        close(w.getActiveCharacter().transform.x, 0, "Undo returns to the start");
    });
}

test("An interrupted gesture without movement records nothing and keeps Redo", () => {
    const scene = gizmoScene();
    const { viewer, controller } = scene;
    controller.setMode("rotate");
    drag(scene, "Y", [[0.05, 0.05], [0.1, 0.1]]);
    viewer.undo();
    frame(scene);
    const history = viewer.history.slice();
    const future = viewer.future.slice();
    pressHandle(scene, "Y");
    viewer.canvas.emit("pointercancel", { pointerId: 1 });
    assert.equal(controller.gizmo.dragging, false);
    assert.equal(scene.orbitChanges.at(-1), true);
    assert.deepEqual(viewer.history, history);
    assert.deepEqual(viewer.future, future);
});

test("A normal release followed by lostpointercapture commits once", () => {
    const scene = gizmoScene();
    const { viewer, controller } = scene;
    controller.setMode("move");
    drag(scene, "X", [[0.05, 0], [0.1, 0]]);
    assert.equal(scene.syncs, 1);
    const history = viewer.history.length;
    viewer.canvas.emit("lostpointercapture", { pointerId: 1 });
    assert.equal(scene.syncs, 1);
    assert.equal(viewer.history.length, history);
});

test("Animation mode disables Move / Rotate and never edits keyframes", () => {
    const scene = gizmoScene();
    const { w, viewer, controller } = scene;
    controller.setMode("move");
    w.exportParams.editor_mode = "animation";
    w.ensureAnimationInitialized?.();
    const keys = JSON.stringify(w.animationState.tracks);
    const transform = { ...w.getActiveCharacter().transform };
    controller.onViewportRender();
    assert.equal(controller.mode, "pose", "animation mode returns to Pose");
    assert.equal(controller.gizmo.object, undefined);
    assert.equal(controller.setMode("rotate"), false);
    assert.equal(controller.mode, "pose");
    assert.equal(controller.fields.inputs.position.x.disabled, true);
    assert.equal(controller.fields.resetRotation.disabled, true);
    assert.match(controller.fields.note.textContent, /Image mode/);
    controller.fields.inputs.position.x.value = "9";
    controller.fields.inputs.position.x.emit("input");
    controller.fields.inputs.position.x.emit("change");
    assert.equal(controller.resetPosition(), false);
    assert.equal(controller.resetRotation(), false);
    assert.deepEqual(w.getActiveCharacter().transform, transform);
    assert.equal(JSON.stringify(w.animationState.tracks), keys);
    assert.equal(viewer.history.length, 0);
    w.exportParams.editor_mode = "image";
    controller.onViewportRender();
    assert.equal(controller.fields.inputs.position.x.disabled, false);
    assert.equal(controller.setMode("move"), true);
});

test("Embedded (UniCanvas) Pose Studio keeps its existing placement controls", () => {
    const scene = createScene({ skinned: true });
    scene.w.host = { embedded: true };
    const controller = new PoseCharacterTransformController(scene.w, { document: scene.document });
    controller.attach(scene.viewer, new Element());
    const panel = new Element();
    controller.renderPanel(panel);
    assert.equal(panel.children.length, 0);
    assert.equal(controller.viewer, null);
    assert.equal(controller.setMode("move"), false);
});
