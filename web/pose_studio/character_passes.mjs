/**
 * Pose Studio per-character passes for the character_json and character_passes
 * outputs (see VNCCS Character Export).
 *
 * For each captured image the widget renders, through the capture camera of
 * that image, the full Character ID pass and one solo render per visible
 * character: the same private character scene as the auxiliary passes with every
 * other character hidden, so parts covered by other characters stay in the
 * character's own normal, depth and silhouette. Python packs the results
 * (nodes/posestudio/character_passes.py).
 */
import { renderConditioningPasses } from "../shared/conditioning_render.mjs";
import {
    buildPoseConditioningScene,
    decodePoseConditioningPixels,
    encodeConditioningPNG,
    poseCharacterIdImage,
    poseConditioningMeshes,
    poseNormalImage,
} from "./conditioning.mjs?v=20261102.1";

/** Node outputs appended after the crop guide outputs, in slot order. */
export const POSE_CHARACTER_OUTPUTS = Object.freeze([
    Object.freeze({ name: "character_json", type: "STRING" }),
    Object.freeze({ name: "character_passes", type: "IMAGE" }),
]);

/** Frames of each character_passes item (one IMAGE batch per exported character). */
export const POSE_CHARACTER_PASS_ORDER = Object.freeze(["normal_solo", "depth_solo", "silhouette"]);

/** Names of the character outputs that are linked on a ComfyUI node, in slot order. */
export function poseCharacterOutputNames(node) {
    const linked = new Set((node?.outputs || [])
        .filter(output => Array.isArray(output?.links) && output.links.length > 0)
        .map(output => output.name));
    return POSE_CHARACTER_OUTPUTS.map(output => output.name).filter(name => linked.has(name));
}

/** Workflows saved before the character outputs existed only gain them at the end; earlier slots and links stay. */
export function ensurePoseCharacterOutputs(node) {
    if (!Array.isArray(node?.outputs) || typeof node.addOutput !== "function") return;
    for (const output of POSE_CHARACTER_OUTPUTS) {
        if (!node.outputs.some(existing => existing?.name === output.name)) node.addOutput(output.name, output.type);
    }
}

/** Packed 24-bit view depth (0 = background) with an opaque alpha so PNG encoding keeps every byte. */
export function poseRawDepthImage(depthPixels) {
    const output = new Uint8Array(depthPixels.length);
    for (let o = 0; o < depthPixels.length; o += 4) {
        if (depthPixels[o + 3] !== 0) {
            output[o] = depthPixels[o]; output[o + 1] = depthPixels[o + 1]; output[o + 2] = depthPixels[o + 2];
        }
        output[o + 3] = 255;
    }
    return output;
}

/**
 * Render the full Character ID pass and one solo pass set per visible
 * character of the current scene through `camera`. Characters whose solo render
 * covers no pixel (entirely outside the frame) are left out. Returns encoded
 * images: `{ clip_far, character_id, characters: [{ slot, normal, depth }] }`
 * with characters in ascending slot order; `depth` is the packed 24-bit view
 * depth of the shared conditioning shader.
 */
export function capturePoseCharacterPasses(viewer, {
    width, height, characters, activeCharacterId,
    camera = viewer.captureCamera, encode = encodeConditioningPNG,
}) {
    const THREE = viewer.THREE;
    if (!THREE || !viewer.renderer || !camera) throw new Error("Pose Studio viewer is not ready for character passes.");
    viewer.scene?.updateMatrixWorld(true);
    if (camera.matrixWorldAutoUpdate !== false) camera.updateMatrixWorld(true);
    const entries = poseConditioningMeshes(viewer, characters, activeCharacterId);
    const evaluation = buildPoseConditioningScene(THREE, entries);
    try {
        const render = () => renderConditioningPasses(
            THREE, viewer.renderer, evaluation.scene, evaluation.materials, camera, width, height,
        );
        const full = decodePoseConditioningPixels(render(), width, height, camera.far);
        const result = {
            clip_far: camera.far,
            character_id: encode(poseCharacterIdImage(full.ids), width, height),
            characters: [],
        };
        for (const [index, entry] of entries.entries()) {
            evaluation.meshes.forEach((mesh, other) => { mesh.visible = other === index; });
            const pixels = render();
            const solo = decodePoseConditioningPixels(pixels, width, height, camera.far);
            if (!solo.ids.some(Boolean)) continue;
            result.characters.push({
                slot: entry.slot,
                normal: encode(poseNormalImage(solo.normal, solo.ids), width, height),
                depth: encode(poseRawDepthImage(pixels.depth), width, height),
            });
        }
        result.characters.sort((left, right) => left.slot - right.slot);
        return result;
    } finally {
        evaluation.dispose();
    }
}
