import assert from "node:assert/strict";
import test from "node:test";
import { PARAMETRIC_PARTS, createParametricGeometry } from "../web/factory3d/geometry/parametric_parts.mjs";
import { normalizedObjectEditorProperties, isSimpleRoomPolygon } from "../web/factory3d/editor_schema.mjs";
import { FactoryMaterialRegistry, createRoomObject } from "../web/factory3d/plan_geometry.mjs";
import { migrateScene11To12 } from "../web/factory3d/core/scene_migrations.mjs";
import * as THREE from "../web/vendor/spark/three.module.js";
import { terrainHeight, sampleTerrainSurface } from "../web/factory3d/geometry/terrain_heightfield.mjs";
import { parametricMetrics } from "../web/factory3d/geometry/parametric_parts.mjs";
import { meshSupportHeight } from "../web/factory3d/geometry/surface_support.mjs";

test("Parametric solids retain physical dimensions, base origin and valid normals", () => {
    for (const kind of Object.keys(PARAMETRIC_PARTS)) {
        const recipe = normalizedObjectEditorProperties({ primitive: { kind, width: 4, height: 3, depth: 6, steps: 17 } }).primitive;
        assert.equal(recipe.kind, kind);
        const geometry = createParametricGeometry(recipe);
        const { min, max } = geometry.boundingBox;
        for (const [actual, expected] of [[min.x, -2], [max.x, 2], [min.y, 0], [max.y, 3], [min.z, -3], [max.z, 3]]) {
            assert.ok(Math.abs(actual - expected) < 1e-5, `${kind}: ${actual} != ${expected}`);
        }
        assert.ok(geometry.attributes.position.count > 8);
        assert.ok(geometry.attributes.normal.array.every(Number.isFinite));
        assert.ok(geometry.attributes.position.array.every(Number.isFinite));
        geometry.dispose();
    }
});

test("Stairs use one closed solid with bounded step count and correct volume", () => {
    const geometry = createParametricGeometry({ kind: "stairs", width: 2, height: 3, depth: 4, steps: 4 });
    const p = geometry.attributes.position;
    let volume = 0;
    for (let i = 0; i < p.count; i += 3) {
        const a = [p.getX(i), p.getY(i), p.getZ(i)];
        const b = [p.getX(i + 1), p.getY(i + 1), p.getZ(i + 1)];
        const c = [p.getX(i + 2), p.getY(i + 2), p.getZ(i + 2)];
        volume += (a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
    }
    assert.ok(Math.abs(volume - 15) < 1e-6);
    geometry.dispose();
    const bounded = normalizedObjectEditorProperties({ primitive: { kind: "stairs", steps: 9999, radial_segments: 1, segments: [8.9, 129] } }).primitive;
    assert.equal(bounded.steps, 256);
    assert.equal(bounded.radial_segments, 8);
    assert.deepEqual(bounded.segments, [8, 128]);
});

test("Scene migration is pure and idempotent, preserves legacy transforms and rejects future versions", () => {
    const old = { schema_version: 11, objects: [{ transform: { position: [1, 2, 3], scale: 2 } }], reference: { file: "reference.png" } };
    const upgraded = migrateScene11To12(old);
    assert.equal(old.schema_version, 11);
    assert.equal(upgraded.schema_version, 12);
    assert.deepEqual(upgraded.objects, old.objects);
    assert.notEqual(upgraded.objects, old.objects);
    assert.deepEqual(migrateScene11To12(upgraded), upgraded);
    assert.throws(() => migrateScene11To12({ schema_version: 99 }));
});

test("Terrain seed is reproducible and sampling matches rendered triangles", () => {
    const recipe = { kind: "terrain", width: 20, depth: 12, segments: [16, 12], height_amplitude: 4, noise_seed: 123, noise_frequency: 0.2, extrusion: 0.2 };
    const geometry = createParametricGeometry(recipe);
    const repeat = createParametricGeometry(recipe);
    assert.deepEqual(geometry.attributes.position.array, repeat.attributes.position.array);
    assert.notEqual(terrainHeight(2.5, 3, recipe), terrainHeight(2.5, 3, { ...recipe, noise_seed: 321 }));
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
    const ray = new THREE.Raycaster(new THREE.Vector3(1.25, 20, -2.25), new THREE.Vector3(0, -1, 0));
    mesh.updateMatrixWorld(true);
    const hit = ray.intersectObject(mesh)[0];
    assert.ok(hit);
    assert.ok(Math.abs(hit.point.y - sampleTerrainSurface(1.25, -2.25, recipe, parametricMetrics(recipe))) < 1e-5);
    assert.equal(sampleTerrainSurface(11, 0, recipe, parametricMetrics(recipe)), null);
    assert.ok(geometry.attributes.normal.array.every(Number.isFinite));
    geometry.dispose(); repeat.dispose(); mesh.material.dispose();
});

test("Surface placement clips sloped geometry to the footprint instead of using the full bounding box", () => {
    const geometry = createParametricGeometry({ kind: "ramp", width: 4, depth: 8, height: 4 });
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
    mesh.position.set(10, 2, 20);
    const footprint = new THREE.Box3(new THREE.Vector3(9.8, 10, 19.8), new THREE.Vector3(10.2, 11, 20.2));
    assert.ok(Math.abs(meshSupportHeight(mesh, footprint) - 4.1) < 1e-5);
    footprint.translate(new THREE.Vector3(100, 0, 0));
    assert.equal(meshSupportHeight(mesh, footprint), null);
    geometry.dispose(); mesh.material.dispose();
});

test("A concave room keeps its empty notch and rejects a crossed contour", () => {
    const polygon = [[0, 0], [4, 0], [4, 1], [1, 1], [1, 4], [0, 4]];
    assert.equal(isSimpleRoomPolygon(polygon), true);
    assert.equal(isSimpleRoomPolygon([[0, 0], [4, 4], [0, 4], [4, 0]]), false);
    const materials = new FactoryMaterialRegistry();
    const room = createRoomObject({ room_id: "a".repeat(32), polygon,
        floor: { enabled: true, thickness: 0.2 }, ceiling: { enabled: false } },
    { elevation: 0, height: 2.8 }, materials);
    room.updateMatrixWorld(true);
    const hits = (x, z) => new THREE.Raycaster(new THREE.Vector3(x, 5, z), new THREE.Vector3(0, -1, 0)).intersectObject(room, true);
    assert.ok(hits(0.5, 3).length > 0);
    assert.equal(hits(3, 3).length, 0);
    room.traverse(item => item.geometry?.dispose());
    materials.dispose();
});
