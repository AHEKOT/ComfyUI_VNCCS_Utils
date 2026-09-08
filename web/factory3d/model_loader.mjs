import * as THREE from "../vendor/spark/three.module.js";
import { GLTFLoader } from "../vendor/spark/loaders/GLTFLoader.js";
import { DRACOLoader } from "../vendor/spark/loaders/DRACOLoader.js";
import { FBXLoader } from "../vendor/spark/loaders/FBXLoader.js";
import { OBJLoader } from "../vendor/spark/loaders/OBJLoader.js";
import { MTLLoader } from "../vendor/spark/loaders/MTLLoader.js";
import { STLLoader } from "../vendor/spark/loaders/STLLoader.js";
import { TGALoader } from "../vendor/spark/loaders/TGALoader.js";
import { MeshoptDecoder } from "../vendor/spark/libs/meshopt_decoder.module.js";


const COLOR_TEXTURE_SLOTS = new Set(["map", "emissiveMap", "sheenColorMap", "specularColorMap"]);
const MATERIAL_TEXTURE_SLOTS = [
    "map", "alphaMap", "aoMap", "bumpMap", "displacementMap", "emissiveMap",
    "envMap", "lightMap", "metalnessMap", "normalMap", "roughnessMap",
    "sheenColorMap", "sheenRoughnessMap", "specularColorMap", "specularIntensityMap",
    "specularMap", "thicknessMap", "transmissionMap",
];


function normalizedResourceKey(value) {
    let text = String(value || "").replace(/\\/g, "/").split(/[?#]/, 1)[0];
    try { text = decodeURIComponent(text); } catch (_error) {}
    text = text.replace(/^[a-z]+:\/\/[^/]+/i, "").replace(/^\.?\//, "");
    const parts = [];
    for (const part of text.split("/")) {
        if (!part || part === ".") continue;
        if (part === "..") parts.pop();
        else parts.push(part);
    }
    return parts.join("/").toLowerCase();
}


function resourceResolver(modelUrl, resources = {}) {
    const exact = new Map();
    const aliases = new Map();
    const ambiguous = new Set();
    for (const [path, url] of Object.entries(resources || {})) {
        const key = normalizedResourceKey(path);
        if (!key || !url) continue;
        exact.set(key, url);
        const base = key.split("/").at(-1);
        if (aliases.has(base) && aliases.get(base) !== url) ambiguous.add(base);
        else aliases.set(base, url);
    }
    for (const key of ambiguous) aliases.delete(key);
    return value => {
        const raw = String(value || "");
        if (!raw || raw.startsWith("data:") || raw.startsWith("blob:")) return raw;
        if (raw === modelUrl) return raw;
        const key = normalizedResourceKey(raw);
        const suffixMatches = Array.from(exact.entries()).filter(
            ([path]) => key === path || key.endsWith(`/${path}`),
        );
        return exact.get(key)
            || (suffixMatches.length === 1 ? suffixMatches[0][1] : "")
            || aliases.get(key.split("/").at(-1))
            || raw;
    };
}


function configureMaterials(root) {
    root.traverse(object => {
        if (!object.isMesh) return;
        object.castShadow = true;
        object.receiveShadow = true;
        if (!object.geometry?.getAttribute?.("normal")) object.geometry?.computeVertexNormals?.();
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of materials) {
            if (!material) continue;
            for (const slot of MATERIAL_TEXTURE_SLOTS) {
                const texture = material[slot];
                if (!texture?.isTexture) continue;
                if (COLOR_TEXTURE_SLOTS.has(slot)) texture.colorSpace = THREE.SRGBColorSpace;
                texture.needsUpdate = true;
            }
            material.needsUpdate = true;
        }
    });
}


function normalizeModel(root) {
    root.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(root);
    if (bounds.isEmpty() || !bounds.min.toArray().every(Number.isFinite)
        || !bounds.max.toArray().every(Number.isFinite)) {
        throw new Error("The imported model has no finite renderable geometry");
    }
    const size = bounds.getSize(new THREE.Vector3());
    const maximum = Math.max(size.x, size.y, size.z);
    if (!(maximum > 1e-9)) throw new Error("The imported model has zero-size geometry");
    const scale = 2 / maximum;
    const center = bounds.getCenter(new THREE.Vector3());
    const normalized = new THREE.Group();
    normalized.name = `${root.name || "Imported model"} content`;
    normalized.scale.setScalar(scale);
    normalized.position.set(-center.x * scale, -bounds.min.y * scale, -center.z * scale);
    normalized.add(root);
    const sceneRoot = new THREE.Group();
    sceneRoot.name = root.name || "Imported model";
    sceneRoot.add(normalized);
    sceneRoot.updateMatrixWorld(true);
    return {
        root: sceneRoot,
        bounds: new THREE.Box3().setFromObject(sceneRoot),
        importScale: scale,
    };
}


function materialFile(resources, modelPath) {
    const entries = Object.keys(resources || {}).filter(path => /\.mtl$/i.test(path));
    if (!entries.length) return "";
    const stem = String(modelPath || "").split("/").at(-1).replace(/\.[^.]+$/, "").toLowerCase();
    return entries.find(path => path.split("/").at(-1).replace(/\.[^.]+$/, "").toLowerCase() === stem)
        || entries[0];
}


export async function loadFactoryModel(
    item,
    resolveAssetURL = value => value,
    onResourcesLoaded = () => {},
) {
    const format = String(item?.source?.format || "").toLowerCase();
    const modelPath = String(item?.source?.model_path || item?.source?.filename || "");
    const modelUrl = resolveAssetURL(item?.urls?.model || "");
    if (!modelUrl) throw new Error(`Object ${item?.object_id || ""} has no model asset URL`);
    const resourceUrls = Object.fromEntries(
        Object.entries(item?.urls?.resources || {}).map(([path, url]) => [path, resolveAssetURL(url)]),
    );
    const manager = new THREE.LoadingManager();
    const waitForResources = () => new Promise(resolve => {
        manager.onLoad = () => {
            onResourcesLoaded();
            resolve();
        };
    });
    manager.setURLModifier(resourceResolver(modelUrl, resourceUrls));
    manager.addHandler(/\.tga$/i, new TGALoader(manager));

    let root;
    let animations = [];
    if (format === "glb" || format === "gltf") {
        const resourcesReady = waitForResources();
        const draco = new DRACOLoader(manager);
        draco.setDecoderPath(new URL("../vendor/spark/libs/draco/gltf/", import.meta.url).href);
        try {
            const loader = new GLTFLoader(manager)
                .setDRACOLoader(draco)
                .setMeshoptDecoder(MeshoptDecoder);
            const result = await loader.loadAsync(modelUrl);
            root = result.scene || result.scenes?.[0];
            animations = result.animations || [];
            await resourcesReady;
        } finally {
            draco.dispose();
        }
    } else if (format === "fbx") {
        const resourcesReady = waitForResources();
        root = await new FBXLoader(manager).loadAsync(modelUrl);
        animations = root.animations || [];
        await resourcesReady;
    } else if (format === "obj") {
        const loader = new OBJLoader(manager);
        const mtlPath = materialFile(resourceUrls, modelPath);
        if (mtlPath) {
            const materials = await new MTLLoader(manager).loadAsync(resourceUrls[mtlPath]);
            const resourcesReady = waitForResources();
            materials.preload();
            loader.setMaterials(materials);
            root = await loader.loadAsync(modelUrl);
            await resourcesReady;
        } else {
            const resourcesReady = waitForResources();
            root = await loader.loadAsync(modelUrl);
            await resourcesReady;
        }
    } else if (format === "stl") {
        const resourcesReady = waitForResources();
        const geometry = await new STLLoader(manager).loadAsync(modelUrl);
        await resourcesReady;
        root = new THREE.Mesh(
            geometry,
            new THREE.MeshStandardMaterial({
                color: geometry.hasColors ? 0xffffff : 0xc8c5d0,
                vertexColors: geometry.hasColors === true,
                opacity: geometry.hasColors ? Number(geometry.alpha ?? 1) : 1,
                transparent: geometry.hasColors && Number(geometry.alpha ?? 1) < 1,
                roughness: 0.72,
                metalness: 0.04,
            }),
        );
    } else {
        throw new Error(`Unsupported imported model format: ${format || "unknown"}`);
    }
    if (!root) throw new Error("The imported model did not contain a displayable scene");
    configureMaterials(root);
    const normalized = normalizeModel(root);
    normalized.root.userData.factoryImportedModel = true;
    return { ...normalized, animations, format };
}


export function disposeFactoryModel(root) {
    const textures = new Set();
    const materials = new Set();
    const geometries = new Set();
    root?.traverse?.(object => {
        if (object.geometry) geometries.add(object.geometry);
        for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
            if (!material) continue;
            materials.add(material);
            for (const slot of MATERIAL_TEXTURE_SLOTS) {
                if (material[slot]?.isTexture) textures.add(material[slot]);
            }
        }
    });
    for (const texture of textures) texture.dispose?.();
    for (const material of materials) material.dispose?.();
    for (const geometry of geometries) geometry.dispose?.();
}
