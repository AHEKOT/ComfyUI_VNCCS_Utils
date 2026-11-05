/**
 * Pose Studio outputs a user enables in Settings > Additional Outputs.
 *
 * A socket position is the slot number in a ComfyUI prompt, and LiteGraph cannot
 * hide a slot. So only enabled outputs have sockets, and the widget saves their
 * names in socket order in `export.additional_outputs`: the backend fills the
 * slots after `lighting_prompt` in that order. Only outputs that also have a link
 * are produced; they are saved in `export.linked_additional_outputs`.
 */
import { POSE_CHARACTER_OUTPUTS } from "./character_passes.mjs?v=20261105.1";
import { POSE_CONDITIONING_OUTPUTS } from "./conditioning.mjs?v=20261105.3";
import { POSE_CROP_GUIDE_OUTPUTS } from "./crop_guide.mjs?v=20261105.1";

/** `images` and `lighting_prompt` are always on the node; additional outputs follow them. */
export const POSE_BASE_OUTPUT_COUNT = 2;

/** Groups of the Additional Outputs settings section. */
export const POSE_ADDITIONAL_OUTPUT_GROUPS = Object.freeze([
    Object.freeze({ title: "Conditioning", outputs: POSE_CONDITIONING_OUTPUTS }),
    Object.freeze({ title: "Crop Guide", outputs: POSE_CROP_GUIDE_OUTPUTS }),
    Object.freeze({ title: "Per-character Export", outputs: POSE_CHARACTER_OUTPUTS }),
]);

const ADDITIONAL_OUTPUTS = new Map(POSE_ADDITIONAL_OUTPUT_GROUPS
    .flatMap(group => group.outputs)
    .map(output => [output.name, output]));
// LiteGraph.GRID_SHAPE marks a list output, like the sockets built from the node definition.
const LIST_OUTPUT_SHAPE = 6;

function additionalSlots(node) {
    return (node?.outputs || []).slice(POSE_BASE_OUTPUT_COUNT).filter(output => ADDITIONAL_OUTPUTS.has(output?.name));
}

/** Enabled additional outputs in slot order: the first name is slot 2, the next slot 3 and so on. */
export function poseAdditionalOutputNames(node) {
    return additionalSlots(node).map(output => output.name);
}

/** Enabled outputs with a link. Anything else is neither rendered nor allocated. */
export function poseLinkedAdditionalOutputNames(node) {
    return additionalSlots(node).filter(output => output.links?.length).map(output => output.name);
}

/**
 * Add or remove one socket. New sockets are appended and removing one lets
 * LiteGraph shift the links of later sockets, so the other links stay connected.
 * Returns whether the node changed.
 */
export function setPoseAdditionalOutput(node, name, enabled) {
    const output = ADDITIONAL_OUTPUTS.get(name);
    if (!output || !Array.isArray(node?.outputs)) return false;
    const index = node.outputs.findIndex((slot, slotIndex) => slotIndex >= POSE_BASE_OUTPUT_COUNT && slot?.name === name);
    if (enabled === index >= 0) return false;
    if (enabled) node.addOutput(name, output.type, { shape: LIST_OUTPUT_SHAPE });
    else node.removeOutput(index);
    return true;
}

/**
 * Hide every additional output that is neither saved as enabled nor linked. A new
 * node keeps only its base outputs, and a workflow keeps what it uses, including
 * links saved when all these outputs were always visible.
 */
export function restorePoseAdditionalOutputs(node, savedNames = []) {
    if (!Array.isArray(node?.outputs) || typeof node.removeOutput !== "function") return;
    const saved = new Set(Array.isArray(savedNames) ? savedNames : []);
    for (let index = node.outputs.length - 1; index >= POSE_BASE_OUTPUT_COUNT; index--) {
        const output = node.outputs[index];
        if (ADDITIONAL_OUTPUTS.has(output?.name) && !saved.has(output.name) && !output.links?.length) {
            node.removeOutput(index);
        }
    }
}

/** Enabled outputs saved in a node's `pose_data` widget. */
export function savedPoseAdditionalOutputs(node) {
    const value = node?.widgets?.find(widget => widget?.name === "pose_data")?.value;
    if (typeof value !== "string" || !value) return [];
    try {
        return JSON.parse(value)?.export?.additional_outputs ?? [];
    } catch {
        return [];
    }
}
