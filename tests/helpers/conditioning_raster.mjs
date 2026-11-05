/**
 * Minimal software WebGL stand-in for Pose Studio capture tests.
 *
 * Render targets get the shared conditioning shader emulated per pixel (24-bit
 * packed view depth, view-space normal, entity colour); the default framebuffer
 * (RGB captures) records which mesh covers each pixel. Both use the same
 * projection, viewport and depth test, so their coverage is directly comparable.
 */
import * as THREE from "../../web/vendor/three/three.module.js";

const PASS_DEPTH = 0, PASS_NORMAL = 1;

function shade(material, viewDepth, normal, frontFacing) {
    const uniforms = material.uniforms;
    if (!uniforms) return null;
    const pass = uniforms.passIndex.value;
    if (pass === PASS_DEPTH) {
        const n = Math.min(16777215, Math.max(1, Math.floor(Math.min(1, Math.max(0, viewDepth / uniforms.clipFar.value)) * 16777215 + 0.5)));
        return [Math.floor(n / 65536), Math.floor(n / 256) % 256, n % 256];
    }
    if (pass === PASS_NORMAL) {
        const sign = frontFacing ? 1 : -1;
        return normal.map(value => Math.round((value * sign * 0.5 + 0.5) * 255));
    }
    return uniforms.entityColor.value.toArray().map(value => Math.round(value * 255));
}

export function createRasterRenderer({ width = 64, height = 64, rgbObjectId = mesh => mesh.id } = {}) {
    let target = null, canvasWidth = width, canvasHeight = height, clearAlpha = 1;
    const clearColor = new THREE.Color(), viewport = new THREE.Vector4(0, 0, width, height);
    const targetBuffers = new WeakMap();
    const renderer = {
        capabilities: { maxTextureSize: 16384 },
        autoClear: true, toneMapping: THREE.NoToneMapping, outputColorSpace: THREE.SRGBColorSpace,
        rgbFrames: [], targetRenders: [],
        getRenderTarget: () => target, getActiveCubeFace: () => 0, getActiveMipmapLevel: () => 0,
        getClearColor: color => color.copy(clearColor), getClearAlpha: () => clearAlpha,
        setClearColor(color, alpha = 1) { clearColor.set(color); clearAlpha = alpha; },
        getViewport: vector => vector.copy(viewport), setViewport(x, y, w, h) {
            if (x?.isVector4) viewport.copy(x); else viewport.set(x, y, w, h);
        },
        getScissor: vector => vector.set(0, 0, canvasWidth, canvasHeight), setScissor() {},
        getScissorTest: () => false, setScissorTest() {},
        setRenderTarget(next) { target = next; },
        getSize: vector => vector.set(canvasWidth, canvasHeight),
        setSize(w, h) { canvasWidth = w; canvasHeight = h; viewport.set(0, 0, w, h); },
        getPixelRatio: () => 1, setPixelRatio() {},
        readRenderTargetPixels(renderTarget, x, y, w, h, output) {
            output.set(targetBuffers.get(renderTarget).color.subarray(0, w * h * 4));
        },
        render(scene, camera) {
            const w = target ? target.width : canvasWidth, h = target ? target.height : canvasHeight;
            const color = new Uint8Array(w * h * 4), owner = new Int32Array(w * h), depth = new Float32Array(w * h).fill(Infinity);
            if (target) targetBuffers.set(target, { color });
            scene.updateMatrixWorld(true);
            if (camera.matrixWorldAutoUpdate !== false && camera.parent === null) camera.updateMatrixWorld(true);
            const view = camera.matrixWorldInverse, projection = camera.projectionMatrix;
            const meshes = [];
            scene.traverseVisible(object => { if (object.isMesh) meshes.push(object); });
            const world = new THREE.Vector3(), viewPoint = new THREE.Vector4(), clip = new THREE.Vector4();
            const normalMatrix = new THREE.Matrix3(), modelView = new THREE.Matrix4(), normal = new THREE.Vector3();
            for (const mesh of meshes) {
                const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
                if (material?.visible === false) continue;
                const geometry = mesh.geometry, position = geometry.getAttribute("position");
                if (!position) continue;
                modelView.multiplyMatrices(view, mesh.matrixWorld);
                normalMatrix.getNormalMatrix(modelView);
                const screen = new Float32Array(position.count * 3), viewDepth = new Float32Array(position.count);
                const valid = new Uint8Array(position.count);
                for (let i = 0; i < position.count; i++) {
                    mesh.getVertexPosition(i, world).applyMatrix4(mesh.matrixWorld);
                    viewPoint.set(world.x, world.y, world.z, 1).applyMatrix4(view);
                    clip.copy(viewPoint).applyMatrix4(projection);
                    if (clip.w <= 1e-9) continue;
                    valid[i] = 1;
                    viewDepth[i] = -viewPoint.z;
                    screen[i * 3] = (clip.x / clip.w + 1) * 0.5 * w;
                    screen[i * 3 + 1] = (clip.y / clip.w + 1) * 0.5 * h;
                    screen[i * 3 + 2] = clip.z / clip.w;
                }
                const normals = geometry.getAttribute("normal");
                const index = geometry.index ? geometry.index.array : Array.from({ length: position.count }, (_, i) => i);
                const objectId = target ? 0 : rgbObjectId(mesh);
                for (let t = 0; t + 2 < index.length; t += 3) {
                    const a = index[t], b = index[t + 1], c = index[t + 2];
                    if (!valid[a] || !valid[b] || !valid[c]) continue;
                    const ax = screen[a * 3], ay = screen[a * 3 + 1], bx = screen[b * 3], by = screen[b * 3 + 1];
                    const cx = screen[c * 3], cy = screen[c * 3 + 1];
                    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
                    if (Math.abs(area) < 1e-12) continue;
                    const frontFacing = area > 0;
                    if (material.side === THREE.FrontSide && !frontFacing) continue;
                    if (material.side === THREE.BackSide && frontFacing) continue;
                    const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx))), maxX = Math.min(w - 1, Math.ceil(Math.max(ax, bx, cx)));
                    const minY = Math.max(0, Math.floor(Math.min(ay, by, cy))), maxY = Math.min(h - 1, Math.ceil(Math.max(ay, by, cy)));
                    for (let py = minY; py <= maxY; py++) {
                        for (let px = minX; px <= maxX; px++) {
                            const sx = px + 0.5, sy = py + 0.5;
                            const w0 = ((bx - sx) * (cy - sy) - (by - sy) * (cx - sx)) / area;
                            const w1 = ((cx - sx) * (ay - sy) - (cy - sy) * (ax - sx)) / area;
                            const w2 = 1 - w0 - w1;
                            if (w0 < 0 || w1 < 0 || w2 < 0) continue;
                            const z = w0 * screen[a * 3 + 2] + w1 * screen[b * 3 + 2] + w2 * screen[c * 3 + 2];
                            if (z < -1 || z > 1) continue;
                            const pixel = py * w + px;
                            if (z >= depth[pixel]) continue;
                            depth[pixel] = z;
                            if (!target) { owner[pixel] = objectId; continue; }
                            // Perspective-correct view depth and normal interpolation.
                            const ia = w0 / viewDepth[a], ib = w1 / viewDepth[b], ic = w2 / viewDepth[c];
                            const sum = ia + ib + ic;
                            const d = 1 / sum;
                            normal.set(0, 0, 0);
                            for (const [vertex, weight] of [[a, ia], [b, ib], [c, ic]]) {
                                normal.x += normals.getX(vertex) * weight / sum;
                                normal.y += normals.getY(vertex) * weight / sum;
                                normal.z += normals.getZ(vertex) * weight / sum;
                            }
                            normal.applyMatrix3(normalMatrix).normalize();
                            const value = shade(material, d, normal.toArray(), frontFacing);
                            color.set([...value, 255], pixel * 4);
                        }
                    }
                }
            }
            if (target) renderer.targetRenders.push({ camera: snapshot(camera) });
            else renderer.rgbFrames.push({ width: w, height: h, owner, camera: snapshot(camera) });
        },
    };
    return renderer;
}

function snapshot(camera) {
    return { projection: camera.projectionMatrix.toArray(), world: camera.matrixWorld.toArray(), far: camera.far };
}

/** Encode raw RGBA pixels as a string so the widget treats them like PNG data URLs. */
export function rawEncode(pixels, width, height) {
    return `raw:${width}x${height}:${Buffer.from(pixels).toString("base64")}`;
}

export function rawDecode(value) {
    const [, size, data] = value.split(":");
    const [width, height] = size.split("x").map(Number);
    return { width, height, pixels: new Uint8Array(Buffer.from(data, "base64")) };
}

/** Flip a bottom-up framebuffer owner map to top-left image rows. */
export function topDownOwners(frame) {
    const { width, height, owner } = frame;
    const output = new Int32Array(width * height);
    for (let y = 0; y < height; y++) output.set(owner.subarray(y * width, (y + 1) * width), (height - 1 - y) * width);
    return output;
}
