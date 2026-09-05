export const EDITOR_VERSION = 18;
export const WORKSPACE_LAYOUTS = Object.freeze(["scene", "architecture", "landscape", "lighting", "camera", "output"]);
const bounded = (value, fallback, min, max) => Number.isFinite(Number(value))
    ? Math.max(min, Math.min(max, Number(value))) : fallback;

export function normalizedWorkspace(value = {}) {
    return {
        left: ["generate", "cameras"].includes(value.left) ? value.left : "generate",
        right: ["objects", "inspector", "export"].includes(value.right) ? value.right : "objects",
        layout: WORKSPACE_LAYOUTS.includes(value.layout) ? value.layout : "scene",
        docked: value.docked !== false,
        left_visible: value.left_visible !== false,
        right_visible: value.right_visible !== false,
        left_width: bounded(value.left_width, 240, 180, 420),
        right_width: bounded(value.right_width, 300, 240, 480),
        tree_fraction: bounded(value.tree_fraction, 0.42, 0.2, 0.75),
    };
}

/** Editor state migration changes UI metadata only, never scene geometry. */
export function migrateEditorState(value = {}) {
    const version = Number(value.schema_version || 0);
    if (!Number.isInteger(version) || version < 0 || version > EDITOR_VERSION) {
        throw new Error(`Unsupported Factory editor version ${value.schema_version}. Update the extension to open this workflow.`);
    }
    const result = globalThis.structuredClone ? structuredClone(value) : JSON.parse(JSON.stringify(value));
    result.schema_version = EDITOR_VERSION;
    result.editor_view = { ...(result.editor_view || result.viewer_state || {}) };
    result.editor_view.workspace = normalizedWorkspace(result.editor_view.workspace);
    return result;
}

/** Fit docks without changing the user's stored dimensions when the node narrows. */
export function fitWorkspaceDocks(state, width) {
    let left = state.left_width, right = state.right_width;
    if (width >= 980) {
        const available = Math.max(0, width - 320);
        const total = (state.left_visible ? left : 0) + (state.right_visible ? right : 0);
        if (total > available) {
            const ratio = available / total;
            if (state.left_visible) left *= ratio;
            if (state.right_visible) right *= ratio;
        }
    }
    return { left, right };
}
