import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "../web/vendor/three/three.module.js";
import { installBodyDrag, isTorsoPoint } from "../web/unicanvas/pose_body_drag.mjs";

const bone = (x, y, z) => ({ getWorldPosition: v => v.set(x, y, z) });

function rig(withHost = false) {
    const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 1000);
    camera.position.set(0, 0, 40); camera.lookAt(0, 0, 0); camera.updateMatrixWorld(true);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(6, 20, 4), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    mesh.updateMatrixWorld(true);
    const handlers = {};
    const canvasHost = withHost ? { appendChild: child => child, getBoundingClientRect: () => ({ left: 0, top: 0 }) } : undefined;
    const canvas = {
        parentElement: canvasHost,
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 400 }),
        addEventListener: (type, fn) => { handlers[type] = fn; }, removeEventListener: noop, setPointerCapture: noop, releasePointerCapture: noop,
    };
    const moves = [];
    const viewer = { deselected: 0, deselectBone() { this.deselected += 1; }, THREE, camera, skinnedMesh: mesh, orbit: { enabled: true }, recordState: noop, _getRaycastableJointMarkers: () => [],
        bones: { pelvis: bone(0, 0, 0), head: bone(0, 9, 0) } };
    const editor = { initialized: true, visible: true, studio: { canvas, viewer },
        layer: { pose: { viewport: { position: [0, 0, 40], target: [0, 0, 0] } } }, backdrop: { moveActiveCharacter: shift => moves.push(shift.clone()) } };
    viewer.editor = editor;
    const dispose = installBodyDrag(editor);
    const event = (type, x, y, extra = {}) => {
        const e = { button: 0, pointerId: 1, clientX: x, clientY: y, shiftKey: false, stoppedNow: false,
            stopImmediatePropagation() { this.stoppedNow = true; }, preventDefault: noop, ...extra };
        handlers[type]?.(e); return e;
    };
    return { viewer, moves, event, dispose, canvasHost };
}
function noop() {}

test("an indicator follows the grab and names the axes: X/Y by default, Z with Shift", () => {
    const made = [];
    globalThis.document = { createElement: () => { const el = { style: {}, hidden: false, children: [], innerHTML: "", textContent: "",
        classList: { toggle(name, on) { el.depth = on; } }, append(...c) { el.children.push(...c); }, remove() { el.removed = true; } }; made.push(el); return el; } };
    try {
        const { event, dispose, canvasHost } = rig(true);
        const root = made[0];
        assert.equal(root.hidden, true, "hidden until a drag starts");
        event("pointerdown", 200, 200);
        assert.equal(root.hidden, false);
        assert.equal(root.style.left, "226px"); assert.equal(root.style.top, "226px", "bottom-right of the grab point");
        assert.match(root.children[1].textContent, /Move/);
        event("pointermove", 210, 190, { shiftKey: true });
        assert.match(root.children[1].textContent, /Depth \(Z\)/);
        assert.match(root.children[0].innerHTML, />Z</);
        event("pointermove", 220, 180);
        assert.match(root.children[1].textContent, /Move/);
        event("pointerup", 220, 180);
        assert.equal(root.hidden, true);
        dispose();
        assert.equal(root.removed, true);
        assert.ok(canvasHost);
    } finally { delete globalThis.document; }
});

test("the trunk is grabbable, the head is not", () => {
    const { viewer } = rig();
    assert.equal(isTorsoPoint(viewer, new THREE.Vector3(0, 1, 2)), true);
    assert.equal(isTorsoPoint(viewer, new THREE.Vector3(0, 8, 2)), false);
});

test("dragging the torso moves the mannequin in the wall plane and disables orbit meanwhile", () => {
    const { viewer, moves, event } = rig();
    const down = event("pointerdown", 200, 200);
    assert.equal(down.stoppedNow, true, "the viewer's own handler must not also run");
    assert.equal(viewer.orbit.enabled, false);
    assert.equal(viewer.deselected, 1, "grabbing the body leaves joint rotation");
    event("pointermove", 240, 200);
    assert.equal(moves.length, 1);
    assert.ok(moves[0].x > 0 && Math.abs(moves[0].y) < 1e-9 && Math.abs(moves[0].z) < 1e-9, "screen-right is world +x on the wall plane");
    event("pointermove", 240, 160);
    assert.ok(moves[1].y > 0 && Math.abs(moves[1].z) < 1e-9, "screen-up is world +y");
    event("pointerup", 240, 160);
    assert.equal(viewer.orbit.enabled, true);
});

test("Shift-drag moves along the view axis only, up = away", () => {
    const { moves, event } = rig();
    event("pointerdown", 200, 200);
    event("pointermove", 260, 150, { shiftKey: true });
    assert.equal(moves.length, 1);
    assert.ok(moves[0].z < 0 && Math.abs(moves[0].x) < 1e-9 && Math.abs(moves[0].y) < 1e-9, "away from the camera, no sideways drift");
});

test("joint markers and non-torso hits are left to Pose Studio", () => {
    const { viewer, moves, event } = rig();
    viewer._getRaycastableJointMarkers = () => [Object.assign(new THREE.Mesh(new THREE.SphereGeometry(3)), {})];
    viewer._getRaycastableJointMarkers()[0].updateMatrixWorld(true);
    const marker = viewer._getRaycastableJointMarkers()[0];
    viewer._getRaycastableJointMarkers = () => [marker];
    assert.equal(event("pointerdown", 200, 200).stoppedNow, false);
    viewer._getRaycastableJointMarkers = () => [];
    assert.equal(event("pointerdown", 5, 5).stoppedNow, false, "a miss is not ours");
    event("pointermove", 100, 100);
    assert.equal(moves.length, 0);
});

test("the torso drag persists the character move when the gesture ends", () => {
    const { viewer, event } = rig();
    const editor = viewer.editor;
    let flushed = 0;
    editor.flushBackdropSync = () => { flushed += 1; };
    event("pointerdown", 200, 200);
    event("pointermove", 240, 200);
    event("pointermove", 250, 210);
    assert.equal(flushed, 0, "no persistence while dragging");
    event("pointerup", 250, 210);
    assert.equal(flushed, 1);
});
