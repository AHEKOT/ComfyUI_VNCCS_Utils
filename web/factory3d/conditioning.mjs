import * as THREE from "../vendor/spark/three.module.js";
import {
    bakeConditioningGeometry as bakeSharedConditioningGeometry,
    createConditioningMaterial,
    flipReadback,
    renderConditioningPasses,
} from "../shared/conditioning_render.mjs";

export { flipReadback };

export const CONDITIONING_BUILD = "20260907.1";
export const COARSE_PROFILE = "Coarse boxes for Gaussian objects";

export function idColor(id) {
    if (!Number.isInteger(id) || id < 1 || id > 16777215) throw new Error("Missing conditioning entity ID");
    return new THREE.Vector3((id >>> 16) / 255, ((id >>> 8) & 255) / 255, (id & 255) / 255);
}

function captureMaterial(source, id) {
    if (source.displacementMap) throw new Error("Bake displacement before geometry conditioning");
    for (const map of [source.map, source.alphaMap]) {
        if (map && map.channel !== 0) throw new Error("Conditioning currently requires alpha textures on UV channel 0");
        if (map?.matrixAutoUpdate) map.updateMatrix();
    }
    return createConditioningMaterial(THREE, {
        side: source.side, entityColor: idColor(id), opacity: source.opacity ?? 1, cutoff: source.alphaTest || 0,
        map: source.map, alphaMap: source.alphaMap,
    });
}

/** Bake a mesh pose without sharing mutable vertex buffers with the live editor. */
export function bakeConditioningGeometry(mesh, worldMatrix = mesh.matrixWorld) {
    return bakeSharedConditioningGeometry(THREE, mesh, worldMatrix);
}

export function buildConditioningScene(viewer, job) {
    const scene = new THREE.Scene(), geometries = [], materials = [], approximations = [];
    const dispose = () => { for (const geometry of geometries) geometry.dispose(); for (const material of materials) material.dispose(); };
    let meshCount = 0, vertexCount = 0;
    const addMesh = (mesh, key, worldMatrix = mesh.matrixWorld) => {
        if (++meshCount > 20000) throw new Error("Conditioning mesh budget exceeded (20000)");
        const sourceMaterials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        if (sourceMaterials.every(material => material.visible === false || material.opacity <= 0)) return;
        vertexCount += mesh.geometry.getAttribute("position")?.count || 0;
        if (vertexCount > 4000000) throw new Error("Conditioning geometry exceeds 4 million evaluated vertices; simplify the scene before capture");
        const geometry = bakeConditioningGeometry(mesh, worldMatrix);
        geometries.push(geometry);
        const replacements = sourceMaterials.map(source => {
            const material = captureMaterial(source, job.entity_ids[key]);
            material.visible = source.visible !== false && source.opacity > 0;
            materials.push(material); return material;
        });
        scene.add(new THREE.Mesh(geometry, Array.isArray(mesh.material) ? replacements : replacements[0]));
    };
    const visit = (root, key) => root.traverseVisible(mesh => {
        if (!mesh.isMesh || mesh.userData.factoryPlanOnly || mesh.userData.ignoreLightOcclusion) return;
        const data = mesh.userData;
        const entityKey = data.factoryId && ["wall", "opening", "room", "floor", "ceiling"].includes(data.factoryType)
            ? `${["floor", "ceiling"].includes(data.factoryType) ? "room" : data.factoryType}:${data.factoryId}` : key;
        if (mesh.isInstancedMesh) {
            if (mesh.morphTexture) throw new Error("Bake per-instance morph targets before geometry conditioning");
            if (mesh.count + meshCount > 20000) throw new Error("Conditioning instance budget exceeded (20000)");
            const matrix = new THREE.Matrix4();
            for (let i = 0; i < mesh.count; i++) {
                mesh.getMatrixAt(i, matrix); matrix.premultiply(mesh.matrixWorld); addMesh(mesh, entityKey, matrix);
            }
        } else addMesh(mesh, entityKey);
    });
    try {
        viewer.scene.updateMatrixWorld(true);
        for (const [id, entry] of viewer.objects) {
            if (entry.mesh?.visible === false) continue;
            const key = `object:${id}`;
            if (entry.splat) {
                if (job.settings.profile !== COARSE_PROFILE) throw new Error(
                    `${entry.data.name || id}: Gaussian geometry is unavailable. Select "${COARSE_PROFILE}" in Factory Render to approve approximate boxes.`);
                const bounds = entry.localBounds;
                if (!bounds || bounds.isEmpty()) throw new Error(`${entry.data.name || id}: no finite proxy bounds`);
                const size = bounds.getSize(new THREE.Vector3()), center = bounds.getCenter(new THREE.Vector3());
                const geometry = new THREE.BoxGeometry(size.x, size.y, size.z);
                geometry.translate(center.x, center.y, center.z);
                const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
                try { addMesh(new THREE.Mesh(geometry, material), key, entry.mesh.matrixWorld); }
                finally { geometry.dispose(); material.dispose(); }
                approximations.push({ entity: key, mode: "box" });
            } else visit(entry.primitive || entry.model || entry.mesh, key);
        }
        visit(viewer.architecture.root, "");
        return { scene, materials, approximations, dispose };
    } catch (error) { dispose(); throw error; }
}

function png(pixels, width, height) {
    const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not encode conditioning pixels");
    context.putImageData(new ImageData(new Uint8ClampedArray(pixels), width, height), 0, 0);
    return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("PNG encoding failed")), "image/png"));
}

/** Synchronous GPU work uses a separate scene/target and leaves the editor canvas intact. */
export function renderConditioningPixels(viewer, job, camera) {
    const { width, height } = job.settings;
    const renderer = viewer.renderer;
    if (Math.max(width, height) > renderer.capabilities.maxTextureSize) throw new Error("Capture exceeds GPU texture limits");
    const evaluation = buildConditioningScene(viewer, job);
    try {
        const pixels = renderConditioningPasses(THREE, renderer, evaluation.scene, evaluation.materials, camera, width, height);
        return { pixels, metadata: { renderer_build: CONDITIONING_BUILD, clip_near: camera.near, clip_far: camera.far,
            projection_matrix: camera.projectionMatrix.toArray(), camera_world_matrix: camera.matrixWorld.toArray(),
            approximations: evaluation.approximations } };
    } finally {
        evaluation.dispose();
    }
}

export async function encodeConditioningPixels(result, width, height) {
    const parts = {};
    for (const name of ["depth", "normal", "object_id"]) {
        parts[name] = await png(result.pixels[name], width, height);
        delete result.pixels[name];
    }
    return { parts, metadata: result.metadata };
}
