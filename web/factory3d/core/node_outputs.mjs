/** Old workflows contain only preview; append without touching slot 0 or links. */
export function ensureFactorySceneOutput(node) {
    if (node.outputs?.length === 1 && node.outputs[0].type === "IMAGE") {
        node.addOutput?.("scene", "VNCCS_FACTORY_SCENE");
    }
}
