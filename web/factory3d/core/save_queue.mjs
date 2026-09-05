/** Freeze ownership and data before waiting for another request to finish. */
export function enqueueFactorySceneSave(previous, sceneId, payload, send) {
    const snapshot = globalThis.structuredClone
        ? globalThis.structuredClone(payload)
        : JSON.parse(JSON.stringify(payload));
    return Promise.resolve(previous).catch(() => null).then(() => send(sceneId, snapshot));
}
