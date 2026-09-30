import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "../web/three.module.js";
import { UniCanvasPoseWall, poseWallPlacement } from "../web/vnccs_unicanvas_pose_wall.mjs";

const framing = { position: [4, 6, 40], target: [0, 5, 0], fov: 40, zoom: 1.5 };
const rect = { x: 100, y: 50, width: 400, height: 300 };

// Project a canvas pixel on the wall through a camera built from the framing.
function project(wall, region, point) {
    const camera = new THREE.PerspectiveCamera(framing.fov, rect.width / rect.height, 0.1, 1000);
    camera.zoom = framing.zoom;
    camera.position.fromArray(framing.position); camera.lookAt(...framing.target); camera.updateProjectionMatrix(); camera.updateMatrixWorld(true);
    const local = new THREE.Vector3((point.x - region.x) / region.width - 0.5, 0.5 - (point.y - region.y) / region.height, 0);
    return local.applyMatrix4(wall.mesh.matrixWorld).project(camera);
}

test("from the framing camera the wall shows the pose rect exactly, even when the wall is larger", () => {
    const region = { x: 0, y: 0, width: 800, height: 600 };
    const wall = new UniCanvasPoseWall(THREE, new THREE.Scene());
    wall.update({ width: 8, height: 6 }, poseWallPlacement(THREE, { rect, region, framing, radius: 5 }));
    const eps = 1e-6;
    for (const [x, y, nx, ny] of [[rect.x, rect.y, -1, 1], [rect.x + rect.width, rect.y + rect.height, 1, -1]]) {
        const ndc = project(wall, region, { x, y });
        assert.ok(Math.abs(ndc.x - nx) < eps && Math.abs(ndc.y - ny) < eps, `rect corner (${x},${y}) -> ${ndc.x},${ndc.y}`);
    }
    // Outside the rect the wall continues instead of ending at the generation box.
    assert.ok(project(wall, region, { x: 0, y: 0 }).x < -1);
});

test("the wall stops a character behind it and lets one in front stay", () => {
    const wall = new UniCanvasPoseWall(THREE, new THREE.Scene());
    const placement = poseWallPlacement(THREE, { rect, region: rect, framing, radius: 5 });
    wall.update({ width: 4, height: 3 }, placement);
    const target = new THREE.Vector3().fromArray(framing.target);
    assert.equal(wall.overflow(target, 2), 0, "standing at the target is in front of the wall");
    const behind = target.clone().addScaledVector(placement.forward, placement.distance * 2);
    assert.ok(wall.overflow(behind, 2) > 0);
    wall.update(null, null);
    assert.equal(wall.overflow(behind, 2), 0, "no wall, no limit");
});
