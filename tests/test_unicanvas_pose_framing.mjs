import assert from "node:assert/strict";
import test from "node:test";
import { applyTorsoFraming, computeTorsoAnchor } from "../web/vnccs_unicanvas_pose_framing.mjs";

const bone = (x, y, z) => ({ getWorldPosition: v => { v.x = x; v.y = y; v.z = z; return v; } });

test("torso anchor is the trunk centroid, never head, neck or limbs", () => {
    const viewer = { bones: { pelvis: bone(0, 3, 0), chest: bone(0, 5, 0), head: bone(0, 7, 0), upper_arm_l: bone(2, 6, 0) } };
    assert.deepEqual(computeTorsoAnchor(viewer), { x: 0, y: 4, z: 0 });
});

test("without torso bones the mesh centre is capped below the head", () => {
    const viewer = { bones: { head: bone(0, 4, 0) }, meshCenter: { x: 0, y: 5, z: 0 },
        skinnedMesh: { geometry: { boundingBox: { min: { y: 0 }, max: { y: 10 } } } } };
    assert.deepEqual(computeTorsoAnchor(viewer), { x: 0, y: 2, z: 0 });
    assert.deepEqual(computeTorsoAnchor({ bones: {}, meshCenter: { x: 1, y: 2, z: 3 } }), { x: 1, y: 2, z: 3 });
    assert.equal(computeTorsoAnchor({ bones: {} }), null);
});

test("framing aims the orbit target at the torso and keeps the view direction at distance 45", () => {
    class V3 {
        constructor(x = 0, y = 0, z = 0) { Object.assign(this, { x, y, z }); }
        copy(o) { return Object.assign(this, { x: o.x, y: o.y, z: o.z }); }
        clone() { return new V3(this.x, this.y, this.z); }
        sub(o) { this.x -= o.x; this.y -= o.y; this.z -= o.z; return this; }
        add(o) { this.x += o.x; this.y += o.y; this.z += o.z; return this; }
        lengthSq() { return this.x ** 2 + this.y ** 2 + this.z ** 2; }
        normalize() { const l = Math.sqrt(this.lengthSq()); return new V3(this.x / l, this.y / l, this.z / l); }
        multiplyScalar(k) { return new V3(this.x * k, this.y * k, this.z * k); }
        set(x, y, z) { return Object.assign(this, { x, y, z }); }
    }
    const viewer = { THREE: { Vector3: V3 }, bones: { pelvis: bone(0, 4, 0) },
        orbit: { target: new V3(), update() {} }, camera: { position: new V3(0, 4, 10) } };
    applyTorsoFraming(viewer);
    assert.equal(viewer.orbit.target.y, 4);
    assert.deepEqual([viewer.camera.position.x, viewer.camera.position.y, viewer.camera.position.z], [0, 4, 45]);
});
