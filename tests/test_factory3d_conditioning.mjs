import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "../web/vendor/spark/three.module.js";
import { idColor, flipReadback, bakeConditioningGeometry, buildConditioningScene, COARSE_PROFILE } from "../web/factory3d/conditioning.mjs";
import { ensureFactorySceneOutput } from "../web/factory3d/core/node_outputs.mjs";

test("Legacy output migration appends once and preserves preview links and slot identity", () => {
    const preview = { name: "preview", type: "IMAGE", links: [12, 34] };
    const node = { outputs: [preview], addOutput(name, type) { this.outputs.push({ name, type, links: null }); } };
    ensureFactorySceneOutput(node); ensureFactorySceneOutput(node);
    assert.equal(node.outputs[0], preview);
    assert.deepEqual(node.outputs[0].links, [12, 34]);
    assert.deepEqual(node.outputs[1], { name: "scene", type: "VNCCS_FACTORY_SCENE", links: null });
    assert.equal(node.outputs.length, 2);
});

test("ID encoding preserves all 24 bits and top-left image row order", () => {
    for (const id of [1, 255, 256, 65535, 65536, 16777215]) {
        const rgb = idColor(id).toArray().map(value => Math.round(value * 255));
        assert.equal(rgb[0] * 65536 + rgb[1] * 256 + rgb[2], id);
    }
    assert.throws(() => idColor(0));
    assert.deepEqual([...flipReadback(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), 1, 2)], [5, 6, 7, 8, 1, 2, 3, 4]);
});

test("Baked mirrored and nonuniform geometry preserves its facing and leaves source buffers unchanged", () => {
    const source = new THREE.PlaneGeometry(2, 2);
    const before = [...source.attributes.position.array];
    const mesh = new THREE.Mesh(source); mesh.scale.set(-2, 3, 1); mesh.rotation.y = 0.3; mesh.position.z = -2;
    mesh.updateMatrixWorld(true);
    const baked = bakeConditioningGeometry(mesh);
    const a = new THREE.Vector3().fromBufferAttribute(baked.attributes.position, baked.index.getX(0));
    const b = new THREE.Vector3().fromBufferAttribute(baked.attributes.position, baked.index.getX(1));
    const c = new THREE.Vector3().fromBufferAttribute(baked.attributes.position, baked.index.getX(2));
    const geometric = b.sub(a).cross(c.sub(a)).normalize();
    const normal = new THREE.Vector3().fromBufferAttribute(baked.attributes.normal, 0).normalize();
    assert.ok(geometric.dot(normal) > 0.999);
    assert.deepEqual([...source.attributes.position.array], before);
    source.dispose(); baked.dispose(); mesh.material.dispose();
});

test("Conditioning excludes helpers and requires explicit approval for Gaussian proxies", () => {
    const scene = new THREE.Scene(), architecture = new THREE.Group(); scene.add(architecture);
    const cube = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial()); scene.add(cube);
    const helper = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()); scene.add(helper);
    const viewer = { scene, architecture: { root: architecture }, objects: new Map([
        ["a", { mesh: cube, primitive: cube, data: { name: "Cube" } }],
    ]) };
    const job = { settings: { profile: "Mesh geometry" }, entity_ids: { "object:a": 1, "object:b": 2 } };
    let evaluation = buildConditioningScene(viewer, job);
    assert.equal(evaluation.scene.children.length, 1);
    assert.equal(evaluation.materials[0].toneMapped, false);
    assert.equal(evaluation.materials[0].blending, THREE.NoBlending);
    evaluation.dispose();
    const splat = new THREE.Group(); scene.add(splat);
    viewer.objects.set("b", { mesh: splat, splat: {}, data: { name: "Tree" }, localBounds: new THREE.Box3(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 3, 1)) });
    assert.throws(() => buildConditioningScene(viewer, job), /Tree.*Gaussian/);
    job.settings.profile = COARSE_PROFILE;
    evaluation = buildConditioningScene(viewer, job);
    assert.equal(evaluation.scene.children.length, 2);
    assert.deepEqual(evaluation.approximations, [{ entity: "object:b", mode: "box" }]);
    evaluation.dispose();
    for (const mesh of [cube, helper]) { mesh.geometry.dispose(); mesh.material.dispose(); }
});
