import assert from "node:assert/strict";
import test from "node:test";
import { PoseViewerCore } from "../web/pose_studio/core.js";
import { POSE_CHARACTER_ID_COLORS } from "../web/pose_studio/conditioning.mjs";
import {
    POSE_CHARACTER_OUTPUTS,
    POSE_CHARACTER_PASS_ORDER,
    ensurePoseCharacterOutputs,
    poseCharacterOutputNames,
    poseRawDepthImage,
} from "../web/pose_studio/character_passes.mjs";
import { createScene } from "./helpers/pose_studio_scene.mjs";
import { createRasterRenderer, rawDecode, rawEncode, topDownOwners } from "./helpers/conditioning_raster.mjs";

const noop = () => {};
const WIDTH = 72, HEIGHT = 96;

function linkedOutputs(names = ["character_json", "character_passes"]) {
    return [
        { name: "images", type: "IMAGE", links: [1] },
        { name: "lighting_prompt", type: "STRING", links: null },
        ...POSE_CHARACTER_OUTPUTS.map((output, index) => ({
            ...output, links: names.includes(output.name) ? [20 + index] : [],
        })),
    ];
}

function characterScene({ outputs = linkedOutputs() } = {}) {
    const scene = createScene({ skinned: true });
    const { w, viewer, node } = scene;
    w.hydrateCharacterSceneModels = async () => {};
    w.setInterfaceMode = noop;
    viewer.setSkinMode = noop;
    scene.context.URLSearchParams = URLSearchParams;
    scene.context.fetch = async () => ({ ok: true, json: async () => ({}) });
    w.showMessage = noop;
    const slots = new Map();
    const renderer = createRasterRenderer({ width: WIDTH, height: HEIGHT, rgbObjectId: mesh => slots.get(mesh) ?? -1 });
    scene.refreshOwners = () => {
        slots.clear();
        slots.set(viewer.skinnedMesh, w.getActiveCharacter().slot + 1);
        for (const [id, entry] of viewer.passiveCharacters) {
            slots.set(entry.mesh, w.characters.find(character => String(character.id) === String(id)).slot + 1);
        }
    };
    viewer.renderer = renderer;
    viewer.canvas.toDataURL = () => `rgb:${renderer.rgbFrames.length - 1}`;
    viewer.captureCharacterPasses = (width, height, options) => PoseViewerCore.prototype.captureCharacterPasses.call(
        viewer, width, height, { ...options, encode: rawEncode },
    );
    w.exportParams.view_width = WIDTH;
    w.exportParams.view_height = HEIGHT;
    node.outputs = outputs;
    scene.renderer = renderer;
    return scene;
}

function run(scene) {
    scene.refreshOwners();
    scene.renderer.rgbFrames.length = 0;
    scene.renderer.targetRenders.length = 0;
    scene.w.syncToNode(true, { executionCapture: true, skipCaptureUpload: true });
    return scene.w._executionCharacterSnapshot;
}

function idSlots(image) {
    const { pixels } = rawDecode(image);
    return Int32Array.from({ length: pixels.length / 4 }, (_, i) => {
        const rgb = [pixels[i * 4], pixels[i * 4 + 1], pixels[i * 4 + 2]];
        if (rgb.every(value => value === 0)) return 0;
        const slot = POSE_CHARACTER_ID_COLORS.findIndex(color => color.every((value, c) => value === rgb[c]));
        assert.ok(slot >= 0, `unknown Character ID colour ${rgb}`);
        return slot + 1;
    });
}

function packedDepth(image) {
    const { pixels } = rawDecode(image);
    return Float64Array.from({ length: pixels.length / 4 }, (_, i) => (
        pixels[i * 4] * 65536 + pixels[i * 4 + 1] * 256 + pixels[i * 4 + 2]));
}

async function overlappingScene(options) {
    const scene = characterScene(options);
    const { w } = scene;
    assert.equal(await w.addCharacter(), true);
    const [, second] = w.characters;
    // Character 2 stands nearer to the camera and covers part of Character 1.
    second.transform = { ...second.transform, z: 6 };
    for (const pose of second.poses) pose.cameraParams = { ...pose.cameraParams, offset_x: 1.5 };
    w.updateCharacterScene();
    return scene;
}

test("character outputs append after the crop outputs and only linked ones are requested", () => {
    assert.deepEqual(POSE_CHARACTER_OUTPUTS.map(output => `${output.name}:${output.type}`),
        ["character_json:STRING", "character_passes:IMAGE"]);
    assert.deepEqual(POSE_CHARACTER_PASS_ORDER, ["normal_solo", "depth_solo", "silhouette"]);
    assert.deepEqual(poseCharacterOutputNames({ outputs: linkedOutputs(["character_passes"]) }), ["character_passes"]);
    assert.deepEqual(poseCharacterOutputNames({ outputs: linkedOutputs([]) }), []);
    assert.deepEqual(poseCharacterOutputNames(undefined), []);
    const crop = { name: "crop_preview", type: "IMAGE", links: [7] };
    const legacy = { outputs: [{ name: "images", links: [1] }, crop], addOutput(name, type) { this.outputs.push({ name, type, links: null }); } };
    ensurePoseCharacterOutputs(legacy);
    ensurePoseCharacterOutputs(legacy);
    assert.equal(legacy.outputs[1], crop);
    assert.deepEqual(legacy.outputs.map(output => output.name), ["images", "crop_preview", "character_json", "character_passes"]);
});

test("packed depth keeps every byte and marks the background with 0", () => {
    const depth = poseRawDepthImage(Uint8Array.from([1, 2, 3, 255, 9, 9, 9, 0]));
    assert.deepEqual([...depth], [1, 2, 3, 255, 0, 0, 0, 255]);
});

test("RUN renders the full ID pass and one solo pass set per character with the RGB camera", async () => {
    const scene = await overlappingScene();
    const { w } = scene;
    const snapshot = run(scene);
    assert.equal(snapshot.length, 1);
    const [entry] = snapshot;
    assert.equal(entry.pose_index, 0);
    assert.equal(entry.pose_name, "Pose 1");
    assert.equal(entry.clip_far, w.viewer.captureCamera.far);
    assert.equal(scene.renderer.targetRenders.length, 9, "three GPU passes for the full scene and per character");
    const frame = scene.renderer.rgbFrames[Number(w.poseCaptures[0].split(":")[1])];
    for (const render of scene.renderer.targetRenders) {
        assert.deepEqual(render.camera.world, frame.camera.world, "solo passes use the capture camera");
    }
    const owners = topDownOwners(frame), ids = idSlots(entry.character_id);
    ids.forEach((slot, i) => assert.equal(slot, owners[i], `Character ID pixel ${i} matches RGB`));
    assert.deepEqual(entry.characters.map(character => character.slot), [0, 1]);

    let occluded = 0;
    for (const character of entry.characters) {
        const depth = packedDepth(character.depth);
        const { pixels: normal, width, height } = rawDecode(character.normal);
        assert.deepEqual([width, height], [WIDTH, HEIGHT]);
        depth.forEach((value, i) => {
            const covered = value > 0;
            const sum = normal[i * 4] + normal[i * 4 + 1] + normal[i * 4 + 2];
            assert.equal(sum > 0, covered, `normal and depth share the solo coverage at ${i}`);
            // Every visible pixel of the character is inside its solo silhouette.
            if (ids[i] === character.slot + 1) assert.ok(covered, `visible pixel ${i} of slot ${character.slot}`);
            if (covered && ids[i] !== character.slot + 1) {
                assert.notEqual(ids[i], 0, "solo pixels outside the visible mask are hidden by another character");
                occluded++;
            }
        });
    }
    assert.ok(occluded > 0, "the solo render of the back character includes its occluded parts");
});

test("unlinked character outputs render nothing and keep RGB captures unchanged", async () => {
    const plain = await overlappingScene({ outputs: linkedOutputs([]) });
    assert.equal(run(plain), null);
    assert.equal(plain.renderer.targetRenders.length, 0, "no extra GPU work without linked character outputs");
    assert.equal(JSON.parse(plain.node.widgets[0].value).export.character_outputs, undefined);
    const plainOwners = topDownOwners(plain.renderer.rgbFrames[0]);

    const linked = await overlappingScene({ outputs: linkedOutputs(["character_json"]) });
    assert.equal(run(linked).length, 1);
    assert.deepEqual(JSON.parse(linked.node.widgets[0].value).export.character_outputs, ["character_json"],
        "pose_data changes with the linked outputs so ComfyUI re-executes the node");
    assert.deepEqual(topDownOwners(linked.renderer.rgbFrames[0]), plainOwners, "RGB capture is unchanged");
});

test("slot gaps keep slots and Character ID colours; hidden and off-frame characters are left out", async () => {
    const scene = characterScene();
    const { w, viewer } = scene;
    assert.equal(await w.addCharacter(2), true);
    assert.deepEqual([...w.characters.map(character => character.slot)], [0, 2]);
    w.updateCharacterScene();
    const [entry] = run(scene);
    assert.deepEqual(entry.characters.map(character => character.slot), [0, 2]);
    assert.ok(idSlots(entry.character_id).includes(3), "slot 2 is ID 3 (blue)");

    // Off-frame: the solo render covers no pixel. Slot 0 is a passive rig (slot 2 is selected);
    // transforms are clamped to +-50 units, far outside this narrow capture frame.
    const first = w.characters.find(character => character.slot === 0);
    first.transform = { ...first.transform, x: 50, y: 50 };
    for (const pose of first.poses) pose.cameraParams = { ...pose.cameraParams, offset_x: 50, offset_y: 50 };
    w.updateCharacterScene();
    assert.deepEqual(run(scene)[0].characters.map(character => character.slot), [2]);
    first.transform = { ...first.transform, x: 0, y: 0 };
    for (const pose of first.poses) pose.cameraParams = { ...pose.cameraParams, offset_x: 0, offset_y: 0 };

    // Hidden in the scene: not rendered at all.
    assert.equal(await w.addCharacter(1), true);
    w.updateCharacterScene();
    const passive = [...viewer.passiveCharacters].find(([id]) => (
        w.characters.find(character => String(character.id) === String(id))?.slot === 0));
    assert.ok(passive, "slot 0 is a passive rig after selecting slot 1");
    passive[1].mesh.visible = false;
    scene.refreshOwners();
    const slots = w.captureCharacterPassSet(WIDTH, HEIGHT, { poseIndex: 0, poseName: "Pose 1" })
        .characters.map(character => character.slot);
    assert.ok(!slots.includes(0), `a hidden character is not exported: ${slots}`);
    assert.ok(slots.includes(1));
});

test("GRID, Pose Manager and Animation runs do not render character passes", async () => {
    const grid = await overlappingScene();
    grid.w.exportParams.output_mode = "GRID";
    assert.equal(run(grid), null);
    assert.equal(grid.renderer.targetRenders.length, 0);
    assert.deepEqual(JSON.parse(grid.node.widgets[0].value).export.character_outputs,
        ["character_json", "character_passes"], "Python sees the linked outputs and stops with an error");

    const manager = characterScene();
    manager.w.interfaceMode = "manager";
    manager.w.renderPoseManager = noop;
    manager.w.updatePoseManagerPreviewImage = noop;
    manager.refreshOwners();
    manager.w.scheduleAllManagerPreviewRefresh();
    for (const [id, frame] of [...manager.frames]) { manager.frames.delete(id); frame(); }
    manager.renderer.targetRenders.length = 0;
    manager.w.syncToNode(true, { executionCapture: true, skipCaptureUpload: true });
    assert.ok(manager.w._executionCaptureSnapshot?.length, "Pose Manager RUN still sends its cards");
    assert.equal(manager.w._executionCharacterSnapshot, null);
    assert.equal(manager.renderer.targetRenders.length, 0);

    const animation = await overlappingScene();
    animation.w.isAnimationMode = () => true;
    animation.w.sampleAnimationFrames = () => [];
    try { run(animation); } catch { /* the animation harness is not complete; only the render matters */ }
    assert.equal(animation.w._executionCharacterSnapshot ?? null, null);
    assert.equal(animation.renderer.targetRenders.length, 0);
});
