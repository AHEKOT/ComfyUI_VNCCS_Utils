import { outputCount } from "./state.mjs";

export function syncPromptOutputs(node, state) {
    if (!Array.isArray(node.outputs) || !node.addOutput || !node.removeOutput) return;
    const count = outputCount(state);
    while (node.outputs.length < count) node.addOutput(`prompt${node.outputs.length + 1}`, "STRING");
    // Restored or existing links must never disappear when a fragment is edited/deleted.
    while (node.outputs.length > count && !node.outputs.at(-1).links?.length) node.removeOutput(node.outputs.length - 1);
    node.outputs.forEach((output, index) => { output.name = index ? `prompt${index + 1}` : "prompt"; });
}
