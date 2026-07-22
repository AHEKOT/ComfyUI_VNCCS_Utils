import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
    MAX_SCENE_COMPONENTS,
    buildHierarchyMetadata,
    computeFitCamera,
    normalizeSceneSpec,
} from "../web/vnccs_img2threejs_scene.mjs";


test("untrusted Scene Spec values are bounded and unknown primitives are replaced", () => {
    const scene = normalizeSceneSpec({
        schemaVersion: 99,
        name: "\u0000 demo ",
        materials: [{ id: "constructor", color: "not-a-color", roughness: 7 }],
        components: [{
            id: "part",
            primitive: "generated-javascript",
            material: "missing",
            transform: {
                position: [Infinity, -Infinity, NaN],
                scale: [0, -2, 1e20],
            },
        }],
    });

    assert.equal(scene.version, 1);
    assert.equal(scene.name, "demo");
    assert.equal(scene.components[0].primitive, "box");
    assert.deepEqual(scene.components[0].position, [0, 0, 0]);
    assert.deepEqual(scene.components[0].scale, [0.0001, 2, 1000]);
    assert.equal(scene.components[0].materialId, scene.materials[0].id);
    assert.equal(scene.materials[0].roughness, 1);
    assert.match(scene.materials[0].id, /^item-/);
    assert.ok(scene.warnings.length >= 2);
});


test("duplicate ids, missing parents, self-parenting and cycles become a safe forest", () => {
    const scene = normalizeSceneSpec({
        components: [
            { id: "a", parent: "b" },
            { id: "b", parent: "a" },
            { id: "self", parent: "self" },
            { id: "orphan", parent: "absent" },
            { id: "a" },
        ],
    });
    const hierarchy = buildHierarchyMetadata(scene.components);

    assert.equal(new Set(scene.components.map((component) => component.id)).size, 5);
    assert.equal(hierarchy.order.length, 5);
    assert.ok(hierarchy.roots.length >= 3);
    for (const id of hierarchy.order) {
        const seen = new Set();
        let current = id;
        while (current) {
            assert.equal(seen.has(current), false, `cycle remains at ${current}`);
            seen.add(current);
            current = hierarchy.byId[current]?.parentId || null;
        }
    }
    assert.ok(scene.warnings.some((warning) => /cycle/i.test(warning)));
    assert.ok(scene.warnings.some((warning) => /cannot parent itself/i.test(warning)));
    assert.ok(scene.warnings.some((warning) => /missing parent/i.test(warning)));
});


test("component counts and camera fitting stay bounded", () => {
    const scene = normalizeSceneSpec({
        components: Array.from({ length: MAX_SCENE_COMPONENTS + 20 }, (_, index) => ({ id: `p-${index}` })),
    });
    assert.equal(scene.components.length, MAX_SCENE_COMPONENTS);

    const camera = computeFitCamera({ min: [-1, -2, -3], max: [1, 2, 3] }, { aspect: 16 / 9 });
    assert.ok(camera.distance > 0);
    assert.ok(camera.far > camera.near);
    assert.deepEqual(camera.center, [0, 0, 0]);

    const elongated = computeFitCamera({ min: [-1.5, -1.5, -5], max: [1.5, 1.5, 5] }, {
        aspect: 0.8,
        fov: 42,
        direction: [0.65, 0.38, 1],
        padding: 1.25,
    });
    const radius = Math.hypot(3, 3, 10) / 2;
    const verticalHalfFov = 42 * Math.PI / 360;
    const horizontalHalfFov = Math.atan(Math.tan(verticalHalfFov) * 0.8);
    assert.ok(elongated.distance >= radius / Math.sin(Math.min(verticalHalfFov, horizontalHalfFov)));
});


test("upstream material layers and exact raw references survive normalization", () => {
    const scene = normalizeSceneSpec({
        materials: [
            { id: "hidden", opacity: { base: 0 }, transmission: { amount: 0.4 } },
            { id: "card", doubleSided: true },
            { id: "a b", color: "#112233" },
            { id: "a-b", color: "#445566" },
        ],
        components: [
            { id: "a b", material: "a b" },
            { id: "a-b", material: "a-b" },
            { id: "child", parent: "a b", material: "hidden" },
        ],
        camera: { up: [0, 0, 1] },
    });

    assert.equal(scene.materials[0].opacity, 0);
    assert.equal(scene.materials[0].transmission, 0.4);
    assert.equal(scene.materials[1].side, "double");
    assert.equal(scene.components[0].materialId, "a-b");
    assert.equal(scene.components[1].materialId, "a-b-2");
    assert.equal(scene.components[2].parentId, "a-b");
    assert.deepEqual(scene.camera.up, [0, 1, 0]);
});


test("img2threejs frontend never evaluates generated source or uses browser dialogs", async () => {
    const files = [
        "../web/vnccs_img2threejs_scene.mjs",
        "../web/vnccs_img2threejs_viewer.js",
        "../web/vnccs_img2threejs_studio.js",
    ];
    const source = (await Promise.all(files.map(async (relative) => (
        readFile(new URL(relative, import.meta.url), "utf8")
    )))).join("\n");

    assert.doesNotMatch(source, /\beval\s*\(/);
    assert.doesNotMatch(source, /new\s+Function\s*\(/);
    assert.doesNotMatch(source, /\b(?:window\.)?(?:alert|confirm|prompt)\s*\(/);
    assert.match(source, /addDOMWidget\(/);
    assert.match(source, /dispose\(\)/);
});
