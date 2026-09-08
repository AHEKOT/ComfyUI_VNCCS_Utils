import * as THREE from "../vendor/spark/three.module.js";

export const CONDITIONING_BUILD = "20260907.1";
export const COARSE_PROFILE = "Coarse boxes for Gaussian objects";

export function idColor(id) {
    if (!Number.isInteger(id) || id < 1 || id > 16777215) throw new Error("Missing conditioning entity ID");
    return new THREE.Vector3((id >>> 16) / 255, ((id >>> 8) & 255) / 255, (id & 255) / 255);
}

export function flipReadback(pixels, width, height) {
    const output = new Uint8Array(pixels.length), stride = width * 4;
    for (let y = 0; y < height; y++) output.set(pixels.subarray(y * stride, (y + 1) * stride), (height - y - 1) * stride);
    return output;
}

const vertexShader = `
varying vec3 viewNormal;
varying float viewDepth;
varying vec2 surfaceUV;
void main() {
    vec4 p = modelViewMatrix * vec4(position, 1.0);
    viewDepth = -p.z;
    viewNormal = normalMatrix * normal;
    surfaceUV = uv;
    gl_Position = projectionMatrix * p;
}`;
const fragmentShader = `
precision highp float;
varying vec3 viewNormal;
varying float viewDepth;
varying vec2 surfaceUV;
uniform int passIndex;
uniform vec3 entityColor;
uniform float clipFar;
uniform float opacity;
uniform float cutoff;
uniform bool hasMap;
uniform bool hasAlphaMap;
uniform sampler2D surfaceMap;
uniform sampler2D alphaMap;
uniform mat3 mapTransform;
uniform mat3 alphaTransform;
void main() {
    float alpha = opacity;
    if (hasMap) alpha *= texture2D(surfaceMap, (mapTransform * vec3(surfaceUV, 1.0)).xy).a;
    if (hasAlphaMap) alpha *= texture2D(alphaMap, (alphaTransform * vec3(surfaceUV, 1.0)).xy).g;
    if (alpha <= 0.0 || alpha < cutoff) discard;
    vec3 value;
    if (passIndex == 0) {
        float n = clamp(floor(clamp(viewDepth / clipFar, 0.0, 1.0) * 16777215.0 + 0.5), 1.0, 16777215.0);
        value = vec3(floor(n / 65536.0), mod(floor(n / 256.0), 256.0), mod(n, 256.0)) / 255.0;
    } else if (passIndex == 1) {
        vec3 n = normalize(viewNormal) * (gl_FrontFacing ? 1.0 : -1.0);
        value = n * 0.5 + 0.5;
    } else value = entityColor;
    gl_FragColor = vec4(value, 1.0);
}`;

function captureMaterial(source, id) {
    if (source.displacementMap) throw new Error("Bake displacement before geometry conditioning");
    for (const map of [source.map, source.alphaMap]) {
        if (map && map.channel !== 0) throw new Error("Conditioning currently requires alpha textures on UV channel 0");
        if (map?.matrixAutoUpdate) map.updateMatrix();
    }
    return new THREE.ShaderMaterial({
        vertexShader, fragmentShader, side: source.side, blending: THREE.NoBlending,
        toneMapped: false, transparent: false, depthTest: true, depthWrite: true,
        uniforms: {
            passIndex: { value: 0 }, entityColor: { value: idColor(id) }, clipFar: { value: 1 },
            opacity: { value: source.opacity ?? 1 }, cutoff: { value: source.alphaTest || 0 },
            hasMap: { value: Boolean(source.map) }, hasAlphaMap: { value: Boolean(source.alphaMap) },
            surfaceMap: { value: source.map || null }, alphaMap: { value: source.alphaMap || null },
            mapTransform: { value: source.map?.matrix.clone() || new THREE.Matrix3() },
            alphaTransform: { value: source.alphaMap?.matrix.clone() || new THREE.Matrix3() },
        },
    });
}

/** Bake a mesh pose without sharing mutable vertex buffers with the live editor. */
export function bakeConditioningGeometry(mesh, worldMatrix = mesh.matrixWorld) {
    const geometry = mesh.geometry.clone();
    if (mesh.isSkinnedMesh || mesh.morphTargetInfluences?.some(value => value !== 0)) {
        mesh.skeleton?.update();
        const position = geometry.getAttribute("position"), vertex = new THREE.Vector3();
        for (let i = 0; i < position.count; i++) {
            mesh.getVertexPosition(i, vertex);
            position.setXYZ(i, vertex.x, vertex.y, vertex.z);
        }
        geometry.morphAttributes = {};
        geometry.computeVertexNormals();
    }
    if (!geometry.getAttribute("normal")) geometry.computeVertexNormals();
    geometry.applyMatrix4(worldMatrix);
    if (worldMatrix.determinant() < 0) {
        if (!geometry.index) geometry.setIndex(Array.from({ length: geometry.attributes.position.count }, (_, i) => i));
        const index = geometry.index;
        for (let i = 0; i < index.count; i += 3) {
            const second = index.getX(i + 1);
            index.setX(i + 1, index.getX(i + 2)); index.setX(i + 2, second);
        }
    }
    return geometry;
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
    const target = new THREE.WebGLRenderTarget(width, height, {
        type: THREE.UnsignedByteType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter, depthBuffer: true, stencilBuffer: false, samples: 0,
    });
    target.texture.colorSpace = THREE.NoColorSpace;
    const previous = { target: renderer.getRenderTarget(), face: renderer.getActiveCubeFace(),
        mip: renderer.getActiveMipmapLevel(), color: renderer.getClearColor(new THREE.Color()),
        alpha: renderer.getClearAlpha(), autoClear: renderer.autoClear,
        toneMapping: renderer.toneMapping, outputColorSpace: renderer.outputColorSpace,
        viewport: renderer.getViewport(new THREE.Vector4()), scissor: renderer.getScissor(new THREE.Vector4()),
        scissorTest: renderer.getScissorTest() };
    try {
        renderer.toneMapping = THREE.NoToneMapping; renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
        renderer.autoClear = true; renderer.setRenderTarget(target); renderer.setViewport(0, 0, width, height);
        renderer.setScissorTest(false); renderer.setClearColor(0, 0);
        const pixels = {};
        for (const [index, name] of ["depth", "normal", "object_id"].entries()) {
            for (const material of evaluation.materials) {
                material.uniforms.passIndex.value = index; material.uniforms.clipFar.value = camera.far;
            }
            renderer.render(evaluation.scene, camera);
            const bytes = new Uint8Array(width * height * 4);
            renderer.readRenderTargetPixels(target, 0, 0, width, height, bytes);
            pixels[name] = flipReadback(bytes, width, height);
        }
        return { pixels, metadata: { renderer_build: CONDITIONING_BUILD, clip_near: camera.near, clip_far: camera.far,
            projection_matrix: camera.projectionMatrix.toArray(), camera_world_matrix: camera.matrixWorld.toArray(),
            approximations: evaluation.approximations } };
    } finally {
        renderer.setRenderTarget(previous.target, previous.face, previous.mip);
        renderer.setViewport(previous.viewport); renderer.setScissor(previous.scissor); renderer.setScissorTest(previous.scissorTest);
        renderer.setClearColor(previous.color, previous.alpha); renderer.autoClear = previous.autoClear;
        renderer.toneMapping = previous.toneMapping; renderer.outputColorSpace = previous.outputColorSpace;
        target.dispose(); evaluation.dispose();
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
