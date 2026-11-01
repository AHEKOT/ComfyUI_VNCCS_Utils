import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "../web/vendor/three/three.module.js";
import { PoseViewerCore } from "../web/pose_studio/core.js";
import {
    POSE_CHARACTER_ID_COLORS,
    POSE_CONDITIONING_OUTPUTS,
    POSE_DEPTH_FAR_LEVEL,
    ensurePoseConditioningOutputs,
    poseCaptureCameraFromSnapshot,
    poseConditioningOutputNames,
    poseConditioningPasses,
    poseDepthImage,
    poseOutlineImage,
    snapshotPoseCaptureCamera,
} from "../web/pose_studio/conditioning.mjs";
import { createScene, Element } from "./helpers/pose_studio_scene.mjs";
import { createRasterRenderer, rawDecode, rawEncode, topDownOwners } from "./helpers/conditioning_raster.mjs";

const noop = () => {};
const WIDTH = 72, HEIGHT = 96;
const PASSES = ["depth", "normal", "outline", "character_id"];

function linkedOutputs(names = POSE_CONDITIONING_OUTPUTS.map(output => output.name)) {
    return [
        { name: "images", type: "IMAGE", links: [1] },
        { name: "lighting_prompt", type: "STRING", links: null },
        ...POSE_CONDITIONING_OUTPUTS.map((output, index) => ({
            ...output, links: names.includes(output.name) ? [10 + index] : [],
        })),
    ];
}

function conditioningScene({ outputs = linkedOutputs() } = {}) {
    const scene = createScene({ skinned: true });
    const { w, viewer, node } = scene;
    w.hydrateCharacterSceneModels = async () => {};
    w.setInterfaceMode = noop;
    viewer.setSkinMode = noop;
    scene.context.URLSearchParams = URLSearchParams;
    scene.context.fetch = async () => ({ ok: true, json: async () => ({}) });
    w.showMessage = noop;
    scene.section = { content: new Element() };
    w.createCaptureLensControls(scene.section);
    const slots = new Map();
    const renderer = createRasterRenderer({
        width: WIDTH, height: HEIGHT,
        // RGB frames record which character covers each pixel (by slot + 1).
        rgbObjectId: mesh => slots.get(mesh) ?? -1,
    });
    scene.rgbOwner = mesh => slots.set(mesh, mesh);
    scene.refreshOwners = () => {
        slots.clear();
        const active = w.getActiveCharacter();
        slots.set(viewer.skinnedMesh, active.slot + 1);
        for (const [id, entry] of viewer.passiveCharacters) {
            slots.set(entry.mesh, w.characters.find(character => String(character.id) === String(id)).slot + 1);
        }
    };
    viewer.renderer = renderer;
    viewer.canvas.toDataURL = () => `rgb:${renderer.rgbFrames.length - 1}`;
    viewer.captureConditioning = (width, height, options) => PoseViewerCore.prototype.captureConditioning.call(
        viewer, width, height, { ...options, encode: rawEncode },
    );
    w.exportParams.view_width = WIDTH;
    w.exportParams.view_height = HEIGHT;
    node.outputs = outputs;
    scene.renderer = renderer;
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

function run(scene) {
    scene.refreshOwners();
    scene.renderer.rgbFrames.length = 0;
    scene.renderer.targetRenders.length = 0;
    scene.w.syncToNode(true, { executionCapture: true, skipCaptureUpload: true });
    return scene.w._executionConditioningSnapshot;
}

function rgbOwners(scene, capture) {
    return topDownOwners(scene.renderer.rgbFrames[Number(capture.split(":")[1])]);
}

function idSlots(image) {
    const { pixels } = rawDecode(image);
    const slots = new Int32Array(pixels.length / 4);
    for (let i = 0; i < slots.length; i++) {
        const rgb = [pixels[i * 4], pixels[i * 4 + 1], pixels[i * 4 + 2]];
        slots[i] = rgb.every(value => value === 0)
            ? 0
            : POSE_CHARACTER_ID_COLORS.findIndex(color => color.every((value, c) => value === rgb[c])) + 1;
        assert.ok(slots[i] >= 0, `pixel ${i} has an anti-aliased or unknown Character ID colour ${rgb}`);
    }
    return slots;
}

function gray(image) {
    const { pixels } = rawDecode(image);
    return Array.from({ length: pixels.length / 4 }, (_, i) => pixels[i * 4]);
}

function bounds(slots) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    slots.forEach((slot, i) => {
        if (!slot) return;
        const x = i % WIDTH, y = Math.floor(i / WIDTH);
        minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    });
    return { minX, maxX, minY, maxY };
}

function assertSameMatrices(actual, expected, message) {
    for (const key of ["projection", "world"]) {
        actual[key].forEach((value, index) => assert.ok(Math.abs(value - expected[key][index]) <= 1e-9,
            `${message} ${key}[${index}]: ${value} != ${expected[key][index]}`));
    }
}

// Every auxiliary pass of capture `index` used that RGB capture's camera, and the
// Character ID coverage equals the RGB coverage pixel for pixel (same depth test).
function assertMatchesRGB(scene, snapshot, index, message) {
    const capture = scene.w.poseCaptures[index];
    const frame = scene.renderer.rgbFrames[Number(capture.split(":")[1])];
    for (const render of scene.renderer.targetRenders.slice(index * 3, index * 3 + 3)) {
        assertSameMatrices(render.camera, frame.camera, message);
    }
    for (const pass of PASSES) {
        const { width, height } = rawDecode(snapshot[index][pass]);
        assert.deepEqual([width, height], [WIDTH, HEIGHT], `${message} ${pass} resolution`);
    }
    const owners = rgbOwners(scene, capture), slots = idSlots(snapshot[index].character_id);
    let covered = 0;
    for (let i = 0; i < slots.length; i++) {
        assert.equal(slots[i], owners[i], `${message} Character ID pixel ${i} matches the RGB image`);
        if (slots[i]) covered++;
    }
    assert.ok(covered > 50, `${message} renders the character (${covered} pixels)`);
    return slots;
}

test("auxiliary outputs append after images and lighting_prompt and only linked ones are requested", () => {
    assert.deepEqual(POSE_CONDITIONING_OUTPUTS.map(output => `${output.name}:${output.type}`), [
        "depth:IMAGE", "normal:IMAGE", "outline:IMAGE", "silhouette:IMAGE", "mask:MASK", "character_id:IMAGE",
    ]);
    assert.deepEqual(poseConditioningOutputNames({ outputs: linkedOutputs(["mask", "depth"]) }), ["depth", "mask"]);
    assert.deepEqual(poseConditioningOutputNames({ outputs: linkedOutputs([]) }), []);
    assert.deepEqual(poseConditioningOutputNames(undefined), []);
    assert.deepEqual(poseConditioningPasses(["mask", "silhouette"]), ["character_id"]);
    assert.deepEqual(poseConditioningPasses(["character_id", "outline", "depth"]), ["depth", "outline", "character_id"]);

    const images = { name: "images", type: "IMAGE", links: [12, 34] };
    const prompt = { name: "lighting_prompt", type: "STRING", links: [56] };
    const legacy = { outputs: [images, prompt], addOutput(name, type) { this.outputs.push({ name, type, links: null }); } };
    ensurePoseConditioningOutputs(legacy);
    ensurePoseConditioningOutputs(legacy);
    assert.equal(legacy.outputs[0], images);
    assert.equal(legacy.outputs[1], prompt);
    assert.deepEqual(legacy.outputs[0].links, [12, 34]);
    assert.deepEqual(legacy.outputs.map(output => output.name), [
        "images", "lighting_prompt", "depth", "normal", "outline", "silhouette", "mask", "character_id",
    ]);
});

test("depth maps near to white and far to the floor level; outlines follow silhouettes and occlusions", () => {
    // 4 x 3 image: a far character (ID 1) behind a near one (ID 2), background column 0.
    const ids = Uint8Array.from([0, 1, 1, 2, 0, 1, 1, 2, 0, 1, 1, 2]);
    const depth = Float32Array.from([0, 10, 10, 5, 0, 10, 10, 5, 0, 10, 10, 5]);
    const image = poseDepthImage(depth, ids);
    const values = Array.from({ length: 12 }, (_, i) => image[i * 4]);
    assert.deepEqual(values, [0, POSE_DEPTH_FAR_LEVEL, POSE_DEPTH_FAR_LEVEL, 255, 0, 32, 32, 255, 0, 32, 32, 255]);
    const outline = poseOutlineImage(depth, ids, 4, 3, { thickness: 1 });
    const lines = Array.from({ length: 12 }, (_, i) => outline[i * 4] ? 1 : 0);
    // ID 1 is outlined against the background; the near character is outlined where
    // it overlaps ID 1, and ID 1 is not outlined against the nearer character.
    assert.deepEqual(lines, [0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1]);

    // Same character, a near arm (depth 4) in front of its body (depth 5): occlusion edge.
    const one = new Uint8Array(5).fill(1);
    const arm = poseOutlineImage(Float32Array.from([5, 5, 4, 4, 5]), one, 5, 1, { thickness: 1 });
    assert.deepEqual(Array.from({ length: 5 }, (_, i) => arm[i * 4] ? 1 : 0), [0, 0, 1, 1, 0]);
    // A smoothly sloped surface (planar in inverse depth) has no interior lines.
    const slope = Float32Array.from([1 / 0.20, 1 / 0.21, 1 / 0.22, 1 / 0.23, 1 / 0.24]);
    const smooth = poseOutlineImage(slope, one, 5, 1, { thickness: 1 });
    assert.deepEqual(Array.from({ length: 5 }, (_, i) => smooth[i * 4]), [0, 0, 0, 0, 0]);
});

test("camera snapshots reproduce the exact capture projection", () => {
    const camera = new THREE.PerspectiveCamera(37, 0.75, 0.1, 500);
    camera.position.set(3, 4, 20); camera.zoom = 1.4; camera.lookAt(1, 2, 0); camera.updateProjectionMatrix();
    const copy = poseCaptureCameraFromSnapshot(THREE, snapshotPoseCaptureCamera(camera));
    assert.deepEqual(copy.projectionMatrix.toArray(), camera.projectionMatrix.toArray());
    assert.deepEqual(copy.matrixWorld.toArray(), camera.matrixWorld.toArray());
    copy.matrixWorldInverse.toArray().forEach((value, index) => assert.ok(Math.abs(value - camera.matrixWorldInverse.elements[index]) < 1e-12));
    assert.equal(copy.far, 500);
});

test("RUN renders every pass with each tab's RGB camera and resolution after FOV and Distance changes", () => {
    const scene = conditioningScene();
    const { w } = scene;
    slide(scene, "cam_fov_deg", 50);
    w.addTab();
    slide(scene, "cam_fov_deg", 20);
    slide(scene, "cam_distance", 90);
    const snapshot = run(scene);
    assert.equal(snapshot.length, 2);
    assert.equal(scene.renderer.targetRenders.length, 6, "three GPU passes per pose");
    const first = assertMatchesRGB(scene, snapshot, 0, "tab 0");
    const second = assertMatchesRGB(scene, snapshot, 1, "tab 1");
    assert.notDeepEqual(bounds(first), bounds(second), "the lens change moves the projection of every output");

    for (const item of snapshot) {
        const slots = idSlots(item.character_id);
        const depth = gray(item.depth), outline = gray(item.outline);
        const { pixels: normal } = rawDecode(item.normal);
        const foreground = depth.filter((_, i) => slots[i]);
        assert.equal(Math.max(...foreground), 255, "nearest surface is white");
        assert.equal(Math.min(...foreground), POSE_DEPTH_FAR_LEVEL, "farthest surface is the floor level");
        slots.forEach((slot, i) => {
            if (slot) {
                assert.ok(depth[i] >= POSE_DEPTH_FAR_LEVEL, "foreground depth stays above the background");
                assert.ok(normal[i * 4] + normal[i * 4 + 1] + normal[i * 4 + 2] > 0, "foreground normal is encoded");
            } else {
                assert.equal(depth[i], 0, "background depth is black");
                assert.equal(outline[i], 0, "outline stays inside the silhouette");
                assert.deepEqual([normal[i * 4], normal[i * 4 + 1], normal[i * 4 + 2]], [0, 0, 0], "background normal is black");
            }
        });
        assert.ok(outline.filter(Boolean).length > 20, "the outline traces the silhouette");
        assert.ok([...slots].filter(Boolean).every((_, i, all) => all[i] === 1), "a single character is ID 1");
    }
    // Unit view-space normals: a pixel facing the camera has a strong blue component.
    const { pixels } = rawDecode(snapshot[0].normal);
    const blues = [...idSlots(snapshot[0].character_id)].flatMap((slot, i) => slot ? [pixels[i * 4 + 2]] : []);
    assert.ok(Math.max(...blues) > 240);
});

test("Align Camera to View: auxiliary passes use the aligned capture camera", () => {
    const scene = conditioningScene();
    const { w, viewer } = scene;
    viewer.camera.position.set(17, 23, 29);
    viewer.orbit.target.set(2, 9, -3);
    viewer.orbit.update();
    viewer.camera.fov = 52; viewer.camera.zoom = 1.3;
    viewer.camera.updateProjectionMatrix(); viewer.camera.updateMatrixWorld(true);
    const before = run(scene);
    const orbitBounds = bounds(idSlots(before[0].character_id));
    w.alignCaptureCameraToView();
    viewer.captureCamera.updateMatrixWorld(true);
    const aligned = viewer.captureCamera.matrixWorld.toArray();
    const snapshot = run(scene);
    assertMatchesRGB(scene, snapshot, 0, "aligned");
    scene.renderer.targetRenders.forEach(render => render.camera.world.forEach((value, index) => (
        assert.ok(Math.abs(value - aligned[index]) < 1e-9, "aligned camera world"))));
    assert.notDeepEqual(bounds(idSlots(snapshot[0].character_id)), orbitBounds);
});

async function twoCharacterScene() {
    const scene = conditioningScene();
    const { w } = scene;
    assert.equal(await w.addCharacter(), true);
    const [first, second] = w.characters;
    // Character 2 overlaps Character 1 and stands nearer to the camera.
    second.transform = { ...second.transform, z: 6 };
    for (const pose of second.poses) pose.cameraParams = { ...pose.cameraParams, offset_x: 1.5 };
    w.updateCharacterScene();
    return { scene, first, second };
}

test("multi-character passes include every character, resolve overlaps like RGB and keep stable IDs", async () => {
    const { scene, first, second } = await twoCharacterScene();
    const { w } = scene;
    assert.equal(w.viewer.passiveCharacters.size, 1, "the second character is rendered as a passive rig");
    const snapshot = run(scene);
    const slots = assertMatchesRGB(scene, snapshot, 0, "two characters");
    const counts = [0, 0, 0];
    slots.forEach(slot => counts[slot]++);
    assert.ok(counts[1] > 30 && counts[2] > 30, `both characters are visible: ${counts}`);
    // The nearer character (ID 2) is brighter in depth.
    const depth = gray(snapshot[0].depth);
    const mean = id => depth.filter((_, i) => slots[i] === id).reduce((sum, value) => sum + value, 0) / counts[id];
    assert.ok(mean(2) > mean(1), "nearer character is brighter");
    // Overlap: ID 2 is drawn over ID 1, and its outline runs along the overlap.
    const outline = gray(snapshot[0].outline);
    let overlapLines = 0;
    slots.forEach((slot, i) => {
        if (slot !== 2 || !outline[i]) return;
        const x = i % WIDTH;
        if ((x > 0 && slots[i - 1] === 1) || (x < WIDTH - 1 && slots[i + 1] === 1)) overlapLines++;
    });
    assert.ok(overlapLines > 0, "the nearer character is outlined where it covers the other one");

    // IDs follow slots, not which character is selected for editing.
    await w.selectCharacter(second.id);
    assert.equal(w.activeCharacterId, second.id);
    const swapped = run(scene);
    assert.deepEqual([...idSlots(swapped[0].character_id)], [...slots], "Character ID is stable across selection");
    assert.equal(first.slot, 0);
    assert.equal(second.slot, 1);
});

test("editor helpers and unknown overlays never reach the auxiliary passes", async () => {
    const { scene } = await twoCharacterScene();
    const { w, viewer } = scene;
    const clean = run(scene)[0];
    // A visible overlay in front of the characters (e.g. future fitting markers),
    // a grid, a capture frame and a joint marker: none is a character mesh.
    const overlay = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    overlay.position.copy(viewer.captureCamera.position).lerp(viewer.sceneCameraTarget, 0.5);
    overlay.lookAt(viewer.captureCamera.position);
    const marker = new THREE.Mesh(new THREE.SphereGeometry(3), new THREE.MeshBasicMaterial());
    marker.position.copy(viewer.sceneCameraTarget);
    const grid = new THREE.GridHelper(100, 10);
    viewer.scene.add(overlay, marker, grid);
    viewer.skinnedMesh.add(new THREE.Mesh(new THREE.BoxGeometry(50, 50, 50), new THREE.MeshBasicMaterial()));
    scene.refreshOwners();
    const images = w.captureConditioningPasses(WIDTH, HEIGHT, PASSES);
    for (const pass of PASSES) assert.equal(images[pass], clean[pass], `${pass} is unchanged by overlays`);
    // Hidden characters are excluded just like in the RGB capture.
    const [[passiveId, passive]] = [...viewer.passiveCharacters];
    const passiveSlot = w.characters.find(character => character.id === passiveId).slot + 1;
    assert.ok(idSlots(clean.character_id).includes(passiveSlot));
    passive.mesh.visible = false;
    const single = idSlots(w.captureConditioningPasses(WIDTH, HEIGHT, ["character_id"]).character_id);
    assert.ok(!single.includes(passiveSlot), "a hidden character is not in the passes");
    assert.ok(single.includes(w.getActiveCharacter().slot + 1));
});

test("unlinked outputs render nothing and keep RGB captures and pose_data unchanged", () => {
    const plain = conditioningScene({ outputs: linkedOutputs([]) });
    assert.equal(run(plain), null);
    assert.equal(plain.renderer.targetRenders.length, 0, "no auxiliary GPU work without linked outputs");
    const plainSaved = JSON.parse(plain.node.widgets[0].value);
    assert.equal(plainSaved.export.conditioning_outputs, undefined);
    const plainOwners = rgbOwners(plain, plain.w.poseCaptures[0]);

    const linked = conditioningScene({ outputs: linkedOutputs(["silhouette", "normal"]) });
    const snapshot = run(linked);
    assert.deepEqual(Object.keys(snapshot[0]).sort(), ["character_id", "normal"]);
    assert.deepEqual(JSON.parse(linked.node.widgets[0].value).export.conditioning_outputs, ["normal", "silhouette"],
        "pose_data changes with the linked outputs so ComfyUI re-executes the node");
    assert.deepEqual(rgbOwners(linked, linked.w.poseCaptures[0]), plainOwners, "RGB capture is unchanged");
});

test("Pose Manager RUN reuses the cards and renders passes with each card's own camera", () => {
    const scene = conditioningScene();
    const { w } = scene;
    slide(scene, "cam_fov_deg", 25);
    w.addTab();
    slide(scene, "cam_fov_deg", 65);
    w.interfaceMode = "manager";
    w.renderPoseManager = noop;
    w.updatePoseManagerPreviewImage = noop;
    scene.refreshOwners();
    const generation = w.scheduleAllManagerPreviewRefresh();
    for (const [id, frame] of [...scene.frames]) { scene.frames.delete(id); frame(); }
    assert.equal(w._managerPreviewRefreshCompletedGeneration, generation);
    const cards = w.poseCaptures.slice();
    const cardFrames = cards.map(capture => scene.renderer.rgbFrames[Number(capture.split(":")[1])]);
    scene.renderer.targetRenders.length = 0;
    const rgbBefore = scene.renderer.rgbFrames.length;
    w.syncToNode(true, { executionCapture: true, skipCaptureUpload: true });
    assert.equal(scene.renderer.rgbFrames.length, rgbBefore, "RUN does not re-render RGB");
    assert.deepEqual(w._executionCaptureSnapshot, cards, "RUN sends the card bytes");
    const snapshot = w._executionConditioningSnapshot;
    assert.equal(snapshot.length, 2);
    cardFrames.forEach((frame, index) => {
        for (const render of scene.renderer.targetRenders.slice(index * 3, index * 3 + 3)) {
            assertSameMatrices(render.camera, frame.camera, `card ${index}`);
        }
        const owners = topDownOwners(frame), slots = idSlots(snapshot[index].character_id);
        slots.forEach((slot, i) => assert.equal(slot, owners[i], `card ${index} pixel ${i}`));
    });
});

test("animation mode refuses linked auxiliary outputs instead of returning blank images", () => {
    const scene = conditioningScene({ outputs: linkedOutputs(["depth"]) });
    scene.w.isAnimationMode = () => true;
    assert.throws(() => scene.w.syncToNode(true, { executionCapture: true, skipCaptureUpload: true }), /Image mode/);
});
