import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "../web/vendor/three/three.module.js";
import {
    POSE_BACKDROP_OFFSET_RADII,
    UniCanvasPoseBackdrop,
    poseBackdropDistance,
    poseBackdropOverflow,
    poseBackdropSize,
} from "../web/unicanvas/pose_backdrop.mjs";

// Minimal Pose Studio viewer: a 2-unit cube stands in for the rig (radius sqrt(3)).
function rig() {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 1000);
    camera.position.set(0, 0, 30);
    camera.lookAt(0, 0, 0);
    scene.add(camera);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshBasicMaterial());
    scene.add(mesh);
    const skydome = new THREE.Mesh(new THREE.SphereGeometry(50), new THREE.MeshBasicMaterial());
    const gridHelper = new THREE.GridHelper(10, 10);
    const renders = [];
    const character = { id: "c0", transform: { x: 0, y: 0, z: 0, zoom: 1 } };
    const viewer = {
        THREE, scene, camera, skinnedMesh: mesh, directionalSkydome: skydome, gridHelper,
        orbit: { target: new THREE.Vector3(0, 0, 0) },
        passiveCharacters: new Map(),
        renderer: { render(sceneArg, cameraArg) { renders.push(cameraArg); } },
        setActiveCharacterAppearance({ transform }) {
            mesh.position.set(transform.x, transform.y, transform.z);
            mesh.updateMatrixWorld(true);
        },
    };
    let syncs = 0;
    const editor = {
        studio: { viewer, characters: [character], getActiveCharacter: () => character },
        scheduleBackdropSync() { syncs += 1; },
    };
    const backdrop = new UniCanvasPoseBackdrop(editor);
    const render = () => viewer.renderer.render(scene, camera);
    return { viewer, mesh, camera, character, backdrop, render, renders, syncs: () => syncs };
}

test("backdrop geometry helpers: distance behind the target, frustum fill, overflow", () => {
    assert.equal(poseBackdropDistance(30, 2), 30 + 2 * POSE_BACKDROP_OFFSET_RADII);
    const size = poseBackdropSize(10, 90, 2, 1);
    assert.ok(Math.abs(size.height - 20) < 1e-9 && Math.abs(size.width - 40) < 1e-9);
    assert.equal(poseBackdropSize(10, 90, 1, 2).height, size.height / 2, "camera zoom narrows the frustum");
    assert.equal(poseBackdropOverflow(10, 1, 20), 0, "a character in front of the backdrop is untouched");
    assert.equal(poseBackdropOverflow(25, 1, 20), 6);
});

test("the backdrop faces the camera, fills the view and hides the skydome and grid", () => {
    const { viewer, backdrop, render, camera } = rig();
    viewer.directionalSkydome.visible = true;
    render();
    assert.equal(viewer.directionalSkydome.visible, false, "no sphere may cover the layers below");
    assert.equal(viewer.gridHelper.visible, false);
    assert.equal(backdrop.plane.parent, camera, "a billboard: it turns with the free camera");
    assert.equal(backdrop.plane.material.colorWrite, false, "depth only; the 2D layers below stay the visible backdrop");
    const expected = poseBackdropDistance(30, backdrop.bounds.radius);
    assert.ok(Math.abs(backdrop.plane.position.z + expected) < 1e-6);
    const size = poseBackdropSize(expected, camera.fov, camera.aspect, camera.zoom);
    assert.ok(Math.abs(backdrop.plane.scale.y - size.height) < 1e-6);
});

test("a character pushed behind the backdrop is pulled back onto it; forward moves stay free", () => {
    const { mesh, character, backdrop, render, syncs } = rig();
    render();
    const distance = backdrop.distance;
    character.transform.z = -40;
    mesh.position.set(0, 0, -40);
    render();
    const after = backdrop.describe().characters[0];
    assert.ok(Math.abs(after.farEdge - distance) < 1e-6, `far edge ${after.farEdge} must sit on the backdrop ${distance}`);
    assert.ok(character.transform.z > -40, "the clamp is written back to the studio character transform");
    assert.ok(Math.abs(character.transform.z - mesh.position.z) < 1e-9);
    assert.equal(syncs(), 1, "the clamped transform is persisted");

    character.transform.z = 20;
    mesh.position.set(0, 0, 20);
    render();
    assert.equal(mesh.position.z, 20, "moving toward the camera (perspective effect) is never limited");
});

test("scaling the character moves the backdrop with it instead of pushing the character", () => {
    const { mesh, backdrop, render } = rig();
    render();
    const before = backdrop.distance;
    mesh.scale.setScalar(4);
    render();
    assert.ok(backdrop.distance > before);
    assert.equal(mesh.position.z, 0, "Zoom alone must not trigger the depth clamp");
});

test("dispose restores the renderer and removes the plane", () => {
    const { viewer, backdrop, render, renders } = rig();
    backdrop.dispose();
    render();
    assert.equal(renders.length, 1);
    assert.equal(backdrop.plane.parent, null);
    assert.equal(typeof viewer.renderer.render, "function");
});

test("orbiting the camera repositions the backdrop and never moves a character", () => {
    const { mesh, camera, character, backdrop, render, syncs } = rig();
    // A character standing well to the side of the orbit target.
    character.transform.x = 12;
    mesh.position.set(12, 0, 0);
    render();
    // Orbit 90 degrees: the sideways offset turns into depth behind the target.
    camera.position.set(-30, 0, 0);
    camera.lookAt(0, 0, 0);
    render();
    assert.equal(mesh.position.x, 12, "the camera move must not push the character");
    assert.equal(syncs(), 0);
    const state = backdrop.describe();
    assert.ok(state.characters[0].farEdge <= state.distance + 1e-6, "the backdrop settles behind the deepest character");
    // After the orbit, moving the character further back still runs into the backdrop.
    character.transform.x = 60;
    mesh.position.set(60, 0, 0);
    render();
    const clamped = backdrop.describe();
    assert.ok(Math.abs(clamped.characters[0].farEdge - clamped.distance) < 1e-6);
    assert.ok(mesh.position.x < 60);
});

test("a character move is mirrored into Pose Studio's camera offset params so slider edits keep it", () => {
    const { character, backdrop } = rig();
    const calls = [];
    const studio = backdrop.editor.studio;
    studio.exportParams = { cam_offset_x: 0, cam_offset_y: 0 };
    studio.persistActivePoseCameraParams = () => { calls.push(["persist", studio.exportParams.cam_offset_x, studio.exportParams.cam_offset_y]); };
    studio.syncCameraWidgets = () => calls.push(["widgets"]);
    backdrop.moveActiveCharacter(new THREE.Vector3(3, -2, 5));
    assert.deepEqual([character.transform.x, character.transform.y, character.transform.z], [3, -2, 5]);
    assert.deepEqual(calls, [["persist", 3, -2], ["widgets"]]);
});
