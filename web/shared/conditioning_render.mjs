/**
 * Geometry-conditioning passes shared by 3D Factory and Pose Studio.
 *
 * The module imports no Three.js build: each caller passes its own `THREE`
 * namespace (3D Factory uses vendor/spark r180, Pose Studio vendor/three r160),
 * so materials, geometries and render targets always belong to the renderer
 * that draws them.
 */

/** Passes rendered by renderConditioningPasses, in render order. */
export const CONDITIONING_PASSES = Object.freeze(["depth", "normal", "object_id"]);

export const CONDITIONING_VERTEX_SHADER = `
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

export const CONDITIONING_FRAGMENT_SHADER = `
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

/** WebGL readback rows start at the bottom; image rows start at the top. */
export function flipReadback(pixels, width, height) {
    const output = new Uint8Array(pixels.length), stride = width * 4;
    for (let y = 0; y < height; y++) output.set(pixels.subarray(y * stride, (y + 1) * stride), (height - y - 1) * stride);
    return output;
}

/**
 * Flat, unlit, unblended pass material. `entityColor` is a THREE.Vector3 in
 * 0..1; surface and alpha maps only cut out transparent texels.
 */
export function createConditioningMaterial(THREE, {
    side, entityColor, opacity = 1, cutoff = 0, map = null, alphaMap = null,
} = {}) {
    return new THREE.ShaderMaterial({
        vertexShader: CONDITIONING_VERTEX_SHADER, fragmentShader: CONDITIONING_FRAGMENT_SHADER,
        side, blending: THREE.NoBlending, toneMapped: false, transparent: false, depthTest: true, depthWrite: true,
        uniforms: {
            passIndex: { value: 0 }, entityColor: { value: entityColor }, clipFar: { value: 1 },
            opacity: { value: opacity }, cutoff: { value: cutoff },
            hasMap: { value: Boolean(map) }, hasAlphaMap: { value: Boolean(alphaMap) },
            surfaceMap: { value: map || null }, alphaMap: { value: alphaMap || null },
            mapTransform: { value: map?.matrix.clone() || new THREE.Matrix3() },
            alphaTransform: { value: alphaMap?.matrix.clone() || new THREE.Matrix3() },
        },
    });
}

/** Bake a mesh pose without sharing mutable vertex buffers with the live editor. */
export function bakeConditioningGeometry(THREE, mesh, worldMatrix = mesh.matrixWorld) {
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

/**
 * Render CONDITIONING_PASSES of a prepared pass scene into a private target.
 * Synchronous GPU work: the editor canvas, its size and renderer state are
 * restored before returning. Returns top-left-ordered RGBA bytes per pass.
 */
export function renderConditioningPasses(THREE, renderer, scene, materials, camera, width, height) {
    if (Math.max(width, height) > renderer.capabilities.maxTextureSize) throw new Error("Capture exceeds GPU texture limits");
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
        for (const [index, name] of CONDITIONING_PASSES.entries()) {
            for (const material of materials) {
                material.uniforms.passIndex.value = index; material.uniforms.clipFar.value = camera.far;
            }
            renderer.render(scene, camera);
            const bytes = new Uint8Array(width * height * 4);
            renderer.readRenderTargetPixels(target, 0, 0, width, height, bytes);
            pixels[name] = flipReadback(bytes, width, height);
        }
        return pixels;
    } finally {
        renderer.setRenderTarget(previous.target, previous.face, previous.mip);
        renderer.setViewport(previous.viewport); renderer.setScissor(previous.scissor); renderer.setScissorTest(previous.scissorTest);
        renderer.setClearColor(previous.color, previous.alpha); renderer.autoClear = previous.autoClear;
        renderer.toneMapping = previous.toneMapping; renderer.outputColorSpace = previous.outputColorSpace;
        target.dispose();
    }
}
