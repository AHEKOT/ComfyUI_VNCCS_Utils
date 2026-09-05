/** Match the node's capture eligibility, including architecture and saved views. */
export function hasRenderableFactoryScene(scene = {}) {
    return Boolean(
        scene?.objects?.length
        || scene?.architecture?.walls?.length
        || scene?.architecture?.rooms?.length
        || scene?.cameras?.length
        || (scene?.skydome && scene.skydome.visible !== false),
    );
}
