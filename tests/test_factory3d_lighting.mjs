import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import * as THREE from "../web/vendor/spark/three.module.js";
import { Factory3DViewer, normalizedLighting, applyFactoryPrimitiveMaterial } from "../web/vnccs_3d_factory_viewer.js";
import { createParametricGeometry } from "../web/factory3d/geometry/parametric_parts.mjs";
import { allocateLocalLightShadows } from "../web/factory3d/lighting_policy.mjs";
import { hasRenderableFactoryScene } from "../web/factory3d/scene_content.mjs";

function light(id, overrides = {}) {
    return {
        light_id: id, kind: "point", position: [0, 1, 0], target: [0, 0, 0],
        color: "#ffffff", intensity: 1, distance: 10, cast_shadow: true,
        level_id: "ground", ...overrides,
    };
}

function lightingViewer(lights) {
    const viewer = Object.create(Factory3DViewer.prototype);
    viewer.lighting = normalizedLighting({ shadows: { quality: "low" }, lights });
    viewer.sceneData = { architecture: { buildings: [] } };
    viewer.viewMode = "3d";
    viewer.activeLevelId = "ground";
    viewer.lightRig = new THREE.Group();
    viewer.ambientLight = new THREE.AmbientLight();
    viewer.sunLight = new THREE.DirectionalLight();
    viewer.lightRig.add(viewer.ambientLight, viewer.sunLight, viewer.sunLight.target);
    viewer.renderer = { capabilities: { maxTextureSize: 4096 }, shadowMap: {} };
    viewer._fitSunShadowCamera = () => {};
    viewer._viewBounds = () => new THREE.Box3(new THREE.Vector3(-2, -2, -2), new THREE.Vector3(2, 2, 2));
    viewer.objects = new Map();
    viewer._syncThreeLights();
    return viewer;
}

test("Closed terrain casts from back faces; live topology changes preserve thin-sheet shadows", () => {
    const material = new THREE.MeshStandardMaterial();
    for (const primitive of [
        { kind: "terrain", height_amplitude: 1 },
        { kind: "terrain", height_amplitude: 0, extrusion: 0.2 },
        { kind: "box" }, { kind: "sphere" }, { kind: "stairs" },
    ]) {
        applyFactoryPrimitiveMaterial(material, primitive, primitive.kind);
        assert.equal(material.side, THREE.DoubleSide, "Visible shading stays double-sided");
        assert.equal(material.shadowSide, THREE.BackSide);
    }
    for (const primitive of [{ kind: "terrain", height_amplitude: 0 }, { kind: "plane" }, { kind: "image", extrusion: 1 }]) {
        applyFactoryPrimitiveMaterial(material, primitive, primitive.kind);
        assert.equal(material.shadowSide, THREE.DoubleSide, "Open sheets and cutouts must still cast");
    }
    const primitive = { kind: "terrain", height_amplitude: 1, extrusion: 0.2, segments: [8, 8] };
    const geometry = createParametricGeometry(primitive);
    applyFactoryPrimitiveMaterial(material, primitive, "terrain");
    const mesh = new THREE.Mesh(geometry, material);
    const ray = new THREE.Raycaster(new THREE.Vector3(0.13, 3, 0.17), new THREE.Vector3(0, -1, 0));
    const frontHit = ray.intersectObject(mesh)[0];
    material.side = material.shadowSide;
    const shadowHit = ray.intersectObject(mesh)[0];
    assert.ok(frontHit && shadowHit, "The solid still blocks light");
    assert.ok(shadowHit.distance > frontHit.distance + 0.1, "The receiving top no longer shadows itself");
    geometry.dispose(); material.dispose();
});

test("Point and spot normal bias follows live settings without scaling with range", () => {
    const viewer = lightingViewer([light("a"), light("b", { kind: "spot" })]);
    const retained = new Map(viewer._localLights);
    for (const normalBias of [0.0015, 0.004, 0]) {
        viewer.lighting.shadows.normal_bias = normalBias;
        for (const distance of [10, 1000]) {
            for (const item of viewer.lighting.lights) item.distance = distance;
            viewer._syncThreeLights();
            for (const [id, item] of viewer._localLights) {
                assert.equal(item, retained.get(id));
                assert.equal(item.shadow.normalBias, normalBias);
                assert.equal(item.shadow.bias, 0);
                assert.equal(item.castShadow, true);
                assert.equal(item.shadow.camera.far, distance);
            }
        }
    }
});

test("Capture eligibility matches the shared Python scene cases", () => {
    const cases = JSON.parse(fs.readFileSync(new URL("./fixtures/factory3d/renderable_scenes.json", import.meta.url)));
    for (const entry of cases) assert.equal(hasRenderableFactoryScene(entry.scene), entry.renderable, entry.name);
});

test("Hidden, zero-strength, hidden-building and other-floor lights do not take Plan shadow slots", () => {
    const lighting = { shadows: { enabled: true, quality: "low" }, lights: [
        light("hidden", { visible: false }), light("zero", { intensity: 0 }),
        light("building", { building_id: "hidden-building" }),
        light("upstairs", { level_id: "upper" }), light("a"), light("b"), light("c"),
    ] };
    const scene = { architecture: { buildings: [{ building_id: "hidden-building", visible: false }] } };
    const states = allocateLocalLightShadows(lighting, scene, { viewMode: "plan", activeLevelId: "ground" });
    assert.deepEqual([...states].filter(([, state]) => state.castShadow).map(([id]) => id), ["a", "b"]);
    for (const id of ["hidden", "zero", "building", "upstairs"]) assert.equal(states.get(id).enabled, false);
    assert.deepEqual(states.get("c"), { enabled: true, castShadow: false, status: "shadow_deferred" });
    lighting.shadows.enabled = false;
    assert.ok([...allocateLocalLightShadows(lighting, scene).values()].every(state => !state.castShadow));
});

test("All eligible mesh lights illuminate beyond each shadow budget and retain runtime identities", () => {
    const viewer = lightingViewer([light("hidden", { visible: false }), light("zero", { intensity: 0 }),
        ...Array.from({ length: 12 }, (_, index) => light(String(index))),
    ]);
    const original = new Map(viewer._localLights);
    for (const [quality, budget] of [["low", 2], ["medium", 4], ["high", 6], ["ultra", 8], ["off", 0]]) {
        viewer.lighting.shadows.quality = quality;
        viewer._syncThreeLights();
        const active = [...viewer._localLights.values()].filter(item => item.visible);
        assert.equal(active.length, 12);
        assert.equal(active.filter(item => item.castShadow).length, budget);
        for (const [id, item] of viewer._localLights) assert.equal(item, original.get(id));
    }
});

test("Gaussian light gain keeps overflow illumination and uses the same global shadow slots as meshes", () => {
    const viewer = lightingViewer([light("far", { position: [0, 100, 0], distance: 1 }), light("blocked"), light("overflow")]);
    let occlusionChecks = 0;
    viewer._visibilityAlongRay = () => { occlusionChecks += 1; return 0; };
    const entry = { localBounds: new THREE.Box3(new THREE.Vector3(-0.5, -0.5, -0.5), new THREE.Vector3(0.5, 0.5, 0.5)),
        mesh: new THREE.Object3D(), data: { level_id: "ground" } };
    const gain = new THREE.Vector3();
    viewer._applyLocalLightGain(entry, gain);
    assert.equal(occlusionChecks, 1);
    assert.ok(Math.abs(gain.x - 0.12) < 1e-9, "The deferred light must still contribute");
    assert.equal(viewer._localLights.get("overflow").castShadow, false);
    viewer.lighting.lights[2].intensity = 4;
    viewer._syncThreeLights();
    viewer._applyLocalLightGain(entry, gain.set(0, 0, 0));
    assert.ok(Math.abs(gain.x - 0.48) < 1e-9, "Newest intensity changes live gain");
});

test("Editing light values retains shadow targets; disabling, type changes and deletion release owned targets", () => {
    const viewer = lightingViewer([light("a"), light("b", { kind: "spot" })]);
    const point = viewer._localLights.get("a");
    const spot = viewer._localLights.get("b");
    let disposed = 0;
    const map = { dispose: () => { disposed += 1; } };
    const mapPass = { dispose: () => { disposed += 1; } };
    point.shadow.map = map;
    point.shadow.mapPass = mapPass;
    Object.assign(viewer.lighting.lights[0], { intensity: 7, color: "#ff0000", position: [1, 2, 3] });
    Object.assign(viewer.lighting.lights[1], { target: [4, 5, 6], angle: 25, penumbra: 0.7 });
    viewer._syncThreeLights();
    assert.equal(viewer._localLights.get("a"), point);
    assert.equal(point.shadow.map, map);
    assert.equal(point.shadow.mapPass, mapPass);
    assert.equal(disposed, 0);
    assert.equal(point.intensity, 7);
    assert.deepEqual(point.position.toArray(), [1, 2, 3]);
    assert.equal(point.color.getHexString(), "ff0000");
    assert.equal(viewer._localLights.get("b"), spot);
    assert.deepEqual(spot.target.position.toArray(), [4, 5, 6]);
    assert.equal(spot.angle, THREE.MathUtils.degToRad(25));
    assert.equal(spot.penumbra, 0.7);
    viewer.lighting.lights[0].visible = false;
    viewer._syncThreeLights();
    assert.equal(disposed, 2);
    assert.equal(point.shadow.map, null);
    assert.equal(viewer._localLights.get("a"), point);
    viewer.lighting.lights[1].kind = "directional";
    viewer._syncThreeLights();
    assert.equal(spot.parent, null);
    assert.equal(spot.target.parent, null);
    const directional = viewer._localLights.get("b");
    assert.equal(directional.isDirectionalLight, true);
    let deleted = 0;
    directional.shadow.map = { dispose: () => { deleted += 1; } };
    viewer.lighting.lights = [];
    viewer._syncThreeLights();
    assert.equal(deleted, 1);
    assert.equal(directional.target.parent, null);
    assert.equal(viewer._localLights.size, 0);
    assert.equal(viewer.lightRig.children.length, 3);
});

test("Reusing lights in another building or floor updates visibility and frees shadows", () => {
    const viewer = lightingViewer([light("a", { building_id: "building" }), light("b", { level_id: "upper" }), light("c")]);
    viewer._refreshSelectionBounds = () => {};
    viewer.spark = { setDirty() {} };
    viewer.invalidate = () => {};
    const a = viewer._localLights.get("a");
    viewer.sceneData.architecture.buildings = [{ building_id: "building", visible: false }];
    viewer.viewMode = "plan";
    viewer.applySceneVisibility(viewer.sceneData);
    assert.equal(a.visible, false);
    assert.equal(viewer._localLights.get("b").visible, false);
    assert.equal(viewer._localLights.get("c").castShadow, true);
    viewer.sceneData.architecture.buildings[0].visible = true;
    viewer.viewMode = "3d";
    viewer.applySceneVisibility(viewer.sceneData);
    assert.equal(viewer._localLights.get("a"), a);
    assert.equal(a.visible, true);
});
