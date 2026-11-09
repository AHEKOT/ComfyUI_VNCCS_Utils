import * as THREE from "../vendor/spark/three.module.js";
import { loadFactoryModel, disposeFactoryModel } from "./model_loader.mjs?v=20260902.2";

// A job preview is deliberately outside the editable/persisted scene object collection.
export class FactoryGenerationPreview {
    constructor(viewer) {
        this.viewer = viewer;
        this.token = 0;
        this.textures = [];
        this.originalTextures = new Set();
    }

    clear() {
        this.token += 1;
        if (this.root) {
            this.viewer.scene.remove(this.root);
            disposeFactoryModel(this.root);
        }
        for (const texture of this.originalTextures) texture.dispose();
        this.originalTextures.clear();
        this.textures = [];
        this.root = null;
        this.url = "";
        this.applied = "";
        this.latest = null;
        this.loading = false;
        this.viewer.invalidate();
    }

    async update(snapshot) {
        if (!snapshot?.preview_url) return;
        if (snapshot.preview_url !== this.url) {
            this.clear();
            this.url = snapshot.preview_url;
        }
        this.latest = snapshot;
        if (this.loading) return;
        this.loading = true;
        const token = this.token;
        const current = () => token === this.token && !this.viewer._disposed;
        try {
            if (!this.root) {
                const loaded = await loadFactoryModel({
                    object_id: snapshot.object_id,
                    source: { format: "glb" }, urls: { model: snapshot.preview_url },
                }, this.viewer.options.resolveAssetURL);
                if (!current()) { disposeFactoryModel(loaded.root); return; }
                this.root = loaded.root;
                this.root.name = "Generation preview";
                this.viewer.scene.add(this.root);
                this.viewer._frameBounds(loaded.bounds, { emit: false });
                this.viewer.invalidate();
            }
            while (current()) {
                const atlas = this.latest.atlas || {};
                const signature = JSON.stringify(atlas);
                if (signature === this.applied) break;
                const entries = Object.entries(atlas).filter(([key]) => ["base_color", "roughness", "metallic"].includes(key));
                const results = await Promise.allSettled(entries.map(async ([key, url]) => {
                    const texture = await new THREE.TextureLoader().loadAsync(this.viewer.options.resolveAssetURL(url));
                    texture.flipY = false;
                    texture.colorSpace = key === "base_color" ? THREE.SRGBColorSpace : THREE.NoColorSpace;
                    return [key, texture];
                }));
                const loaded = results.filter(item => item.status === "fulfilled").map(item => item.value);
                const failure = results.find(item => item.status === "rejected");
                if (!current() || signature !== JSON.stringify(this.latest.atlas || {}) || failure) {
                    for (const [, texture] of loaded) texture.dispose();
                    if (failure && current()) throw failure.reason;
                    continue;
                }
                const maps = Object.fromEntries(loaded);
                this.root.traverse(object => {
                    if (!object.isMesh) return;
                    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
                        for (const [key, slot] of [["base_color", "map"], ["roughness", "roughnessMap"], ["metallic", "metalnessMap"]]) {
                            if (!maps[key]) continue;
                            const previous = material[slot];
                            if (previous && !this.textures.includes(previous)) this.originalTextures.add(previous);
                            material[slot] = maps[key];
                        }
                        if (maps.roughness) material.roughness = 1;
                        if (maps.metallic) material.metalness = 1;
                        material.needsUpdate = true;
                    }
                });
                for (const texture of this.textures) texture.dispose();
                this.textures = loaded.map(([, texture]) => texture);
                this.applied = signature;
                this.viewer.invalidate();
            }
        } finally {
            if (current()) this.loading = false;
        }
    }
}
