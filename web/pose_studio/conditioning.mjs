/**
 * Pose Studio auxiliary control images (depth, normal, outline, silhouette,
 * mask, Character ID).
 *
 * The passes reuse the 3D Factory conditioning renderer (shared/conditioning_render.mjs)
 * and draw a private scene that contains only baked character meshes, so the
 * grid, capture frame, bones, joint markers, reference images, gizmos, imported
 * figure overlays and any other editor helper can never appear in them. They are
 * rendered with the capture camera of the matching RGB image.
 */
import {
    bakeConditioningGeometry,
    createConditioningMaterial,
    renderConditioningPasses,
} from "../shared/conditioning_render.mjs";

/** Node outputs appended after `images` and `lighting_prompt`, in slot order. */
export const POSE_CONDITIONING_OUTPUTS = Object.freeze([
    Object.freeze({ name: "depth", type: "IMAGE" }),
    Object.freeze({ name: "normal", type: "IMAGE" }),
    Object.freeze({ name: "outline", type: "IMAGE" }),
    Object.freeze({ name: "silhouette", type: "IMAGE" }),
    Object.freeze({ name: "mask", type: "MASK" }),
    Object.freeze({ name: "character_id", type: "IMAGE" }),
]);

/**
 * Character ID colours by character slot (Character 1 = slot 0 = ID 1).
 * Background is ID 0 / black. Pure primaries keep every character a single
 * exact colour that one channel threshold separates.
 */
export const POSE_CHARACTER_ID_COLORS = Object.freeze([
    Object.freeze([255, 0, 0]),
    Object.freeze([0, 255, 0]),
    Object.freeze([0, 0, 255]),
    Object.freeze([255, 255, 0]),
]);

/** Gray level of the farthest visible surface; the nearest one is 255 and background 0. */
export const POSE_DEPTH_FAR_LEVEL = 32;
/** Relative inverse-depth step that marks an interior occlusion edge in the outline. */
export const POSE_OUTLINE_DEPTH_STEP = 0.01;

const PASS_ORDER = ["depth", "normal", "outline", "character_id"];
const PASS_FOR_OUTPUT = {
    depth: "depth", normal: "normal", outline: "outline",
    silhouette: "character_id", mask: "character_id", character_id: "character_id",
};

/** Names of the auxiliary outputs that are linked on a ComfyUI node, in slot order. */
export function poseConditioningOutputNames(node) {
    const linked = new Set((node?.outputs || [])
        .filter(output => Array.isArray(output?.links) && output.links.length > 0)
        .map(output => output.name));
    return POSE_CONDITIONING_OUTPUTS.map(output => output.name).filter(name => linked.has(name));
}

/** Passes the browser must render and upload for the requested outputs. */
export function poseConditioningPasses(outputNames = []) {
    const needed = new Set(outputNames.map(name => PASS_FOR_OUTPUT[name]).filter(Boolean));
    return PASS_ORDER.filter(pass => needed.has(pass));
}

/** Workflows saved before these outputs existed only append them; slots 0 and 1 and their links stay. */
export function ensurePoseConditioningOutputs(node) {
    if (!Array.isArray(node?.outputs) || typeof node.addOutput !== "function") return;
    for (const output of POSE_CONDITIONING_OUTPUTS) {
        if (!node.outputs.some(existing => existing?.name === output.name)) node.addOutput(output.name, output.type);
    }
}

export function poseCharacterIdColor(slot) {
    const color = POSE_CHARACTER_ID_COLORS[slot];
    if (!Number.isInteger(slot) || !color) throw new Error(`Character slot ${slot} has no Character ID colour.`);
    return color;
}

function visibleInScene(object) {
    for (let item = object; item; item = item.parent) if (item.visible === false) return false;
    return true;
}

/** Character meshes drawn in the RGB capture, paired with their stable slots. */
export function poseConditioningMeshes(viewer, characters = [], activeCharacterId = null) {
    const entries = [];
    for (const character of characters) {
        const mesh = String(character?.id) === String(activeCharacterId)
            ? viewer.skinnedMesh
            : viewer.passiveCharacters?.get?.(String(character?.id))?.mesh;
        if (!mesh?.geometry || !visibleInScene(mesh)) continue;
        entries.push({ mesh, slot: character.slot });
    }
    return entries;
}

/** Exact camera state of a capture, reusable after the shared capture camera moves on. */
export function snapshotPoseCaptureCamera(camera) {
    camera.updateMatrixWorld(true);
    return {
        near: camera.near, far: camera.far,
        projection: camera.projectionMatrix.toArray(),
        world: camera.matrixWorld.toArray(),
    };
}

export function poseCaptureCameraFromSnapshot(THREE, snapshot) {
    const camera = new THREE.PerspectiveCamera();
    camera.near = snapshot.near; camera.far = snapshot.far;
    camera.matrixAutoUpdate = false; camera.matrixWorldAutoUpdate = false;
    camera.projectionMatrix.fromArray(snapshot.projection);
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
    camera.matrixWorld.fromArray(snapshot.world);
    camera.matrix.copy(camera.matrixWorld);
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
    return camera;
}

function buildPoseConditioningScene(THREE, entries) {
    const scene = new THREE.Scene(), geometries = [], materials = [];
    const dispose = () => {
        for (const geometry of geometries) geometry.dispose();
        for (const material of materials) material.dispose();
    };
    try {
        for (const { mesh, slot } of entries) {
            const [r, g, b] = poseCharacterIdColor(slot);
            const entityColor = new THREE.Vector3(r / 255, g / 255, b / 255);
            const geometry = bakeConditioningGeometry(THREE, mesh);
            geometries.push(geometry);
            const sources = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
            // Unlit flat colours: lighting, skin texture and model colour never reach the passes.
            const replacements = sources.map(source => {
                const material = createConditioningMaterial(THREE, { side: source?.side ?? THREE.DoubleSide, entityColor });
                material.visible = source?.visible !== false;
                materials.push(material);
                return material;
            });
            scene.add(new THREE.Mesh(geometry, Array.isArray(mesh.material) ? replacements : replacements[0]));
        }
        return { scene, materials, dispose };
    } catch (error) {
        dispose();
        throw error;
    }
}

/** Decode the shared renderer's passes into per-pixel depth, Character IDs and normals. */
export function decodePoseConditioningPixels(pixels, width, height, clipFar) {
    const count = width * height;
    const depth = new Float32Array(count), ids = new Uint8Array(count);
    const idPixels = pixels.object_id, depthPixels = pixels.depth;
    for (let i = 0; i < count; i++) {
        const o = i * 4;
        if (idPixels[o + 3] === 0) continue;
        const slot = POSE_CHARACTER_ID_COLORS.findIndex(color => color[0] === idPixels[o]
            && color[1] === idPixels[o + 1] && color[2] === idPixels[o + 2]);
        if (slot < 0) throw new Error("Character ID pass contains an unknown colour.");
        ids[i] = slot + 1;
        depth[i] = (depthPixels[o] * 65536 + depthPixels[o + 1] * 256 + depthPixels[o + 2]) * (clipFar / 16777215);
    }
    return { depth, ids, normal: pixels.normal };
}

/** Grayscale camera depth: nearest surface 255, farthest POSE_DEPTH_FAR_LEVEL, background 0. */
export function poseDepthImage(depth, ids) {
    let near = Infinity, far = -Infinity;
    for (let i = 0; i < ids.length; i++) {
        if (!ids[i]) continue;
        near = Math.min(near, depth[i]); far = Math.max(far, depth[i]);
    }
    const range = far - near;
    const output = new Uint8Array(ids.length * 4);
    for (let i = 0; i < ids.length; i++) {
        const value = !ids[i] ? 0 : range > 0
            ? Math.round(255 - (depth[i] - near) / range * (255 - POSE_DEPTH_FAR_LEVEL))
            : 255;
        const o = i * 4;
        output[o] = output[o + 1] = output[o + 2] = value; output[o + 3] = 255;
    }
    return output;
}

/** View-space normal (R = +X right, G = +Y up, B = +Z toward the camera) on a black background. */
export function poseNormalImage(normal, ids) {
    const output = new Uint8Array(ids.length * 4);
    for (let i = 0; i < ids.length; i++) {
        const o = i * 4;
        if (ids[i]) { output[o] = normal[o]; output[o + 1] = normal[o + 1]; output[o + 2] = normal[o + 2]; }
        output[o + 3] = 255;
    }
    return output;
}

export function poseCharacterIdImage(ids) {
    const output = new Uint8Array(ids.length * 4);
    for (let i = 0; i < ids.length; i++) {
        const o = i * 4;
        if (ids[i]) {
            const color = POSE_CHARACTER_ID_COLORS[ids[i] - 1];
            output[o] = color[0]; output[o + 1] = color[1]; output[o + 2] = color[2];
        }
        output[o + 3] = 255;
    }
    return output;
}

/**
 * White lines on black. A character pixel is on the outline when a 4-neighbour
 * is background, another character behind it, or a surface of the same character
 * behind it (an inverse-depth step of at least POSE_OUTLINE_DEPTH_STEP). Lines
 * lie on the nearer side, inside the silhouette, and get thicker on larger images.
 */
export function poseOutlineImage(depth, ids, width, height, {
    step = POSE_OUTLINE_DEPTH_STEP,
    thickness = Math.max(1, Math.round(Math.min(width, height) / 640)),
} = {}) {
    const inverse = new Float32Array(ids.length);
    for (let i = 0; i < ids.length; i++) inverse[i] = ids[i] ? 1 / depth[i] : 0;
    const edge = new Uint8Array(ids.length);
    const directions = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const p = y * width + x;
            if (!ids[p]) continue;
            for (const [dx, dy] of directions) {
                const qx = x + dx, qy = y + dy;
                // The image border is not a contour: characters may extend past the frame.
                if (qx < 0 || qy < 0 || qx >= width || qy >= height) continue;
                const q = qy * width + qx;
                if (!ids[q]) { edge[p] = 1; break; }
                if (ids[q] !== ids[p]) {
                    if (inverse[p] >= inverse[q]) { edge[p] = 1; break; }
                    continue;
                }
                if (inverse[p] <= inverse[q]) continue;
                // Planes are affine in inverse depth, so the second difference
                // stays near zero on smooth surfaces and spikes at occlusions.
                // At the image border the surface continuation is unknown: no interior line.
                const rx = x - dx, ry = y - dy;
                if (rx < 0 || ry < 0 || rx >= width || ry >= height) continue;
                const r = ry * width + rx;
                const jump = ids[r] === ids[p]
                    ? 2 * inverse[p] - inverse[q] - inverse[r]
                    : inverse[p] - inverse[q];
                if (jump > step * inverse[p]) { edge[p] = 1; break; }
            }
        }
    }
    const radius = thickness - 1;
    const lines = radius > 0 ? new Uint8Array(ids.length) : edge;
    if (radius > 0) {
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                if (!edge[y * width + x]) continue;
                for (let oy = Math.max(0, y - radius); oy <= Math.min(height - 1, y + radius); oy++) {
                    for (let ox = Math.max(0, x - radius); ox <= Math.min(width - 1, x + radius); ox++) {
                        if (ids[oy * width + ox]) lines[oy * width + ox] = 1;
                    }
                }
            }
        }
    }
    const output = new Uint8Array(ids.length * 4);
    for (let i = 0; i < ids.length; i++) {
        const o = i * 4, value = lines[i] ? 255 : 0;
        output[o] = output[o + 1] = output[o + 2] = value; output[o + 3] = 255;
    }
    return output;
}

export function encodeConditioningPNG(pixels, width, height) {
    const canvas = globalThis.document.createElement("canvas");
    canvas.width = width; canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not encode Pose Studio conditioning pixels.");
    context.putImageData(new ImageData(new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.byteLength), width, height), 0, 0);
    return canvas.toDataURL("image/png");
}

/**
 * Render the requested passes of the current character scene through `camera`
 * (the capture camera of the matching RGB image). Returns encoded images keyed
 * by pass name.
 */
export function capturePoseConditioning(viewer, {
    width, height, characters, activeCharacterId, passes,
    camera = viewer.captureCamera, encode = encodeConditioningPNG,
}) {
    const THREE = viewer.THREE;
    if (!THREE || !viewer.renderer || !camera) throw new Error("Pose Studio viewer is not ready for auxiliary passes.");
    if (!passes?.length) return {};
    viewer.scene?.updateMatrixWorld(true);
    if (camera.matrixWorldAutoUpdate !== false) camera.updateMatrixWorld(true);
    const entries = poseConditioningMeshes(viewer, characters, activeCharacterId);
    const evaluation = buildPoseConditioningScene(THREE, entries);
    let pixels;
    try {
        pixels = renderConditioningPasses(THREE, viewer.renderer, evaluation.scene, evaluation.materials, camera, width, height);
    } finally {
        evaluation.dispose();
    }
    const decoded = decodePoseConditioningPixels(pixels, width, height, camera.far);
    const images = {};
    for (const pass of passes) {
        const image = pass === "depth" ? poseDepthImage(decoded.depth, decoded.ids)
            : pass === "normal" ? poseNormalImage(decoded.normal, decoded.ids)
                : pass === "outline" ? poseOutlineImage(decoded.depth, decoded.ids, width, height)
                    : poseCharacterIdImage(decoded.ids);
        images[pass] = encode(image, width, height);
    }
    return images;
}
