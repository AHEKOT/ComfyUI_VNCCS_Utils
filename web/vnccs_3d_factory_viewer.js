import * as THREE from "./vendor/spark/three.module.js";
import { OrbitControls } from "./vendor/spark/OrbitControls.js";
import { TransformControls } from "./vendor/spark/TransformControls.js";
import {
    dyno,
    SparkRenderer,
    SplatMesh,
} from "./vendor/spark/spark.module.js";
import { FactoryArchitectureRuntime } from "./factory3d/plan_geometry.mjs?v=20260825.4";
import { solveDropToSurface } from "./factory3d/support_solver.mjs?v=20260825.3";


const EMPTY = () => {};
const HEAVY_SCENE_GAUSSIANS = 262_145;
const SPLAT_SCAN_CHUNK = 16_384;
const SPLAT_BOUND_SAMPLES = 4_096;
const INTERACTIVE_FRAME_MS = 1000 / 30;
const LIGHTING_UPDATE_MS = 1000 / 15;
const LIGHTING_BASE_RESPONSE = 0.65;
const MAX_PLAN_GRID_LINES_PER_AXIS = 800;
export const FACTORY_VIEWER_BUILD = "20260825.16";

const DEFAULT_LIGHTING = Object.freeze({
    preset: "day",
    intensity: 0.72,
    color: "#fff1d6",
    azimuth: 325,
    elevation: 42,
    ambient: 0.5,
    background: "#171b25",
    shadows: Object.freeze({ enabled: true, quality: "medium", bias: -0.0005, normal_bias: 0.02 }),
    lights: Object.freeze([]),
});

const DEFAULT_SKYDOME = Object.freeze({
    visible: true,
    yaw: 0,
    pitch: 0,
    roll: 0,
    exposure: 0,
    blur: 0,
});

export function normalizedLighting(value = {}) {
    const data = { ...DEFAULT_LIGHTING, ...(value && typeof value === "object" ? value : {}) };
    const numberOr = (candidate, fallback) => {
        const number = Number(candidate);
        return Number.isFinite(number) ? number : fallback;
    };
    const color = /^#[0-9a-f]{6}$/i.test(String(data.color || ""))
        ? String(data.color).toLowerCase()
        : DEFAULT_LIGHTING.color;
    const background = /^#[0-9a-f]{6}$/i.test(String(data.background || ""))
        ? String(data.background).toLowerCase()
        : DEFAULT_LIGHTING.background;
    const preset = ["off", "day", "night", "dawn", "sunset", "custom"].includes(data.preset)
        ? data.preset
        : DEFAULT_LIGHTING.preset;
    const shadows = data.shadows && typeof data.shadows === "object" ? data.shadows : {};
    const lights = (Array.isArray(data.lights) ? data.lights : []).slice(0, 32).map(light => ({
        ...light,
        kind: ["point", "spot", "directional"].includes(light?.kind) ? light.kind : "point",
        position: finiteVector(light?.position, [0, 2, 0]),
        target: finiteVector(light?.target, [0, 0, -1]),
        color: /^#[0-9a-f]{6}$/i.test(String(light?.color || "")) ? light.color : "#ffffff",
        intensity: Math.max(0, Math.min(100000, Number(light?.intensity) || 0)),
        distance: Math.max(0, Math.min(1000000, Number(light?.distance) || 0)),
        angle: Math.max(1, Math.min(179, numberOr(light?.angle, 45))),
        penumbra: Math.max(0, Math.min(1, numberOr(light?.penumbra, 0.2))),
        cast_shadow: light?.cast_shadow !== false,
        visible: light?.visible !== false,
    }));
    const quality = ["off", "low", "medium", "high", "ultra"].includes(shadows.quality)
        ? shadows.quality
        : "medium";
    return {
        preset,
        intensity: Math.max(0, Math.min(3, Number(data.intensity) || 0)),
        color,
        azimuth: ((Number(data.azimuth) || 0) % 360 + 360) % 360,
        elevation: Math.max(-10, Math.min(90, Number(data.elevation) || 0)),
        ambient: Math.max(0, Math.min(1.5, Number(data.ambient) || 0)),
        background,
        shadows: {
            enabled: shadows.enabled !== false && quality !== "off",
            quality,
            bias: Math.max(-0.1, Math.min(0.1, numberOr(shadows.bias, -0.0005))),
            normal_bias: Math.max(0, Math.min(10, numberOr(shadows.normal_bias, 0.02))),
        },
        lights,
    };
}

export function lightSourceDirection(
    azimuthDegrees = 0,
    elevationDegrees = 0,
    target = new THREE.Vector3(),
) {
    const azimuth = THREE.MathUtils.degToRad(azimuthDegrees);
    const elevation = THREE.MathUtils.degToRad(elevationDegrees);
    const horizontal = Math.cos(elevation);
    // Match Pose Studio/THREE.DirectionalLight exactly: the radar dot is the
    // source position and the implicit target is the world origin. Rays stay
    // parallel across the scene; this vector points from the target back to
    // the source, which is the vector used by Lambert-style lighting.
    // 0° = BACK (-Z), 90° = RIGHT (+X), 180° = FRONT (+Z).
    return target.set(
        horizontal * Math.sin(azimuth),
        Math.sin(elevation),
        -horizontal * Math.cos(azimuth),
    ).normalize();
}

export function createDirectionalLightingModifier() {
    const objectCenter = dyno.dynoVec3(new THREE.Vector3());
    const inverseHalfSize = dyno.dynoVec3(new THREE.Vector3(1, 1, 1));
    const lightSource = dyno.dynoVec3(new THREE.Vector3(0, 1, 0));
    const baseGain = dyno.dynoVec3(new THREE.Vector3(1, 1, 1));
    const directionalScale = dyno.dynoVec3(new THREE.Vector3());
    const lighting = new dyno.Dyno({
        inTypes: {
            gsplat: dyno.Gsplat,
            objectCenter: "vec3",
            inverseHalfSize: "vec3",
            lightSource: "vec3",
            baseGain: "vec3",
            directionalScale: "vec3",
        },
        outTypes: { gsplat: dyno.Gsplat },
        inputs: {
            objectCenter,
            inverseHalfSize,
            lightSource,
            baseGain,
            directionalScale,
        },
        globals: () => [dyno.defineGsplat],
        statements: ({ inputs, outputs }) => dyno.unindentLines(`
            ${outputs.gsplat} = ${inputs.gsplat};
            if (isGsplatActive(${outputs.gsplat}.flags)) {
                vec3 vnccsObjectOffset = (
                    ${outputs.gsplat}.center - ${inputs.objectCenter}
                ) * ${inputs.inverseHalfSize};
                float vnccsObjectDistanceSquared = dot(
                    vnccsObjectOffset,
                    vnccsObjectOffset
                );
                float vnccsSourceFacing = dot(
                    vnccsObjectOffset * inversesqrt(max(
                        vnccsObjectDistanceSquared,
                        0.000001
                    )),
                    ${inputs.lightSource}
                );
                float vnccsLightCoordinate = clamp(
                    0.56 + 0.56 * vnccsSourceFacing,
                    0.0,
                    1.0
                );
                float vnccsShapedLight = vnccsLightCoordinate * vnccsLightCoordinate
                    * (3.0 - 2.0 * vnccsLightCoordinate);
                float vnccsLightResponse = 0.12 + 0.88 * vnccsShapedLight;
                ${outputs.gsplat}.rgba.rgb = clamp(
                    ${outputs.gsplat}.rgba.rgb * (
                        ${inputs.baseGain}
                        + ${inputs.directionalScale} * (vnccsLightResponse - 0.65)
                    ),
                    vec3(0.0),
                    vec3(4.0)
                );
            }
        `),
    });
    return {
        modifier: lighting,
        objectCenter,
        inverseHalfSize,
        lightSource,
        baseGain,
        directionalScale,
    };
}

export function normalizedSkydome(value = {}) {
    const source = value && typeof value === "object" ? value : {};
    const data = { ...DEFAULT_SKYDOME, ...source };
    const bounded = (key, minimum, maximum) => {
        const number = Number(data[key]);
        return Math.max(
            minimum,
            Math.min(maximum, Number.isFinite(number) ? number : DEFAULT_SKYDOME[key]),
        );
    };
    return {
        ...source,
        type: "skydome",
        projection: "equirectangular",
        visible: data.visible !== false,
        yaw: bounded("yaw", -180, 180),
        pitch: bounded("pitch", -90, 90),
        roll: bounded("roll", -180, 180),
        exposure: bounded("exposure", -4, 4),
        blur: bounded("blur", 0, 1),
    };
}

function finiteVector(values, fallback = [0, 0, 0]) {
    return fallback.map((item, index) => {
        const value = Number(values?.[index]);
        return Number.isFinite(value) ? value : item;
    });
}

function normalizedTransform(value = {}) {
    const scale = Number(value.scale);
    return {
        position: finiteVector(value.position),
        rotation: finiteVector(value.rotation),
        scale: Number.isFinite(scale) ? Math.max(0.001, Math.min(1000, scale)) : 1,
    };
}

export function effectiveVisibleObjectIds(sceneData = {}) {
    const objects = new Map(
        (Array.isArray(sceneData.objects) ? sceneData.objects : [])
            .filter(item => item?.object_id)
            .map(item => [item.object_id, item]),
    );
    const visible = new Set();
    const hiddenBuildingIds = new Set(
        (sceneData.architecture?.buildings || [])
            .filter(building => building?.visible === false)
            .map(building => building.building_id),
    );
    const objectVisible = item => item?.visible !== false
        && (!item?.building_id || !hiddenBuildingIds.has(item.building_id));
    const layers = Array.isArray(sceneData.layers) ? sceneData.layers : [];
    const assigned = new Set();
    for (const layer of layers) {
        if (layer?.type === "object" && objects.has(layer.object_id)) {
            assigned.add(layer.object_id);
            if (objectVisible(objects.get(layer.object_id))) visible.add(layer.object_id);
            continue;
        }
        if (layer?.type !== "group" || !Array.isArray(layer.children)) continue;
        for (const objectId of layer.children) {
            if (!objects.has(objectId) || assigned.has(objectId)) continue;
            assigned.add(objectId);
            if (layer.visible !== false && objectVisible(objects.get(objectId))) {
                visible.add(objectId);
            }
        }
    }
    for (const [objectId, item] of objects) {
        if (!assigned.has(objectId) && objectVisible(item)) visible.add(objectId);
    }
    return visible;
}

/**
 * TripoSplat's official viewer applies these two rotations after loading the
 * exported Gaussian: child yaw +90° around Y, then parent flip 180° around X.
 * Keep this separate from the editable scene transform so a new object still
 * has position/rotation 0 and scale 1.
 */
export function triposplatCanonicalMatrix() {
    return new THREE.Matrix4()
        .makeRotationX(Math.PI)
        .multiply(new THREE.Matrix4().makeRotationY(Math.PI / 2));
}

function degrees(value) {
    return value * 180 / Math.PI;
}

function radians(value) {
    return value * Math.PI / 180;
}

export function validateSplatBuffer(buffer, label = "SPLAT asset") {
    if (!(buffer instanceof ArrayBuffer)) {
        throw new TypeError(`${label} did not return an ArrayBuffer`);
    }
    if (!buffer.byteLength) {
        throw new Error(`${label} is empty`);
    }
    if (buffer.byteLength % 32 !== 0) {
        throw new Error(
            `${label} contains ${buffer.byteLength.toLocaleString()} bytes; `
            + "a compact SPLAT must contain exactly 32 bytes per Gaussian",
        );
    }
    return buffer;
}

function scanSplatRange(buffer, source, state, start, end) {
    for (let index = start; index < end; index += 1) {
        const offset = index * 32;
        const x = source.getFloat32(offset, true);
        const y = source.getFloat32(offset + 4, true);
        const z = source.getFloat32(offset + 8, true);
        const sx = source.getFloat32(offset + 12, true);
        const sy = source.getFloat32(offset + 16, true);
        const sz = source.getFloat32(offset + 20, true);
        const valid = Number.isFinite(x)
            && Number.isFinite(y)
            && Number.isFinite(z)
            && Number.isFinite(sx)
            && Number.isFinite(sy)
            && Number.isFinite(sz)
            && Math.abs(x) <= 1_000_000
            && Math.abs(y) <= 1_000_000
            && Math.abs(z) <= 1_000_000
            && sx > 0
            && sy > 0
            && sz > 0
            && sx <= 1_000_000
            && sy <= 1_000_000
            && sz <= 1_000_000;
        if (!valid) {
            if (!state.output) {
                state.output = buffer.slice(0);
                state.target = new DataView(state.output);
            }
            state.invalid += 1;
            state.target.setFloat32(offset, 0, true);
            state.target.setFloat32(offset + 4, 0, true);
            state.target.setFloat32(offset + 8, 0, true);
            state.target.setFloat32(offset + 12, 0.000001, true);
            state.target.setFloat32(offset + 16, 0.000001, true);
            state.target.setFloat32(offset + 20, 0.000001, true);
            state.target.setUint8(offset + 27, 0);
            state.target.setUint8(offset + 28, 255);
            state.target.setUint8(offset + 29, 128);
            state.target.setUint8(offset + 30, 128);
            state.target.setUint8(offset + 31, 128);
            continue;
        }
        if (source.getUint8(offset + 27) <= 0) continue;
        state.visible += 1;
        if (index % state.sampleStride === 0) {
            state.coordinates[0].push(x);
            state.coordinates[1].push(y);
            state.coordinates[2].push(z);
        }
    }
}

function splatScanState(buffer) {
    const count = buffer.byteLength / 32;
    return {
        count,
        output: null,
        target: new DataView(buffer),
        invalid: 0,
        visible: 0,
        sampleStride: Math.max(1, Math.ceil(count / SPLAT_BOUND_SAMPLES)),
        coordinates: [[], [], []],
    };
}

function splatScanResult(buffer, label, state) {
    if (!state.visible) {
        throw new Error(
            `${label} contains ${state.count.toLocaleString()} records but no finite visible Gaussians`
            + (state.invalid ? ` (${state.invalid.toLocaleString()} invalid records)` : ""),
        );
    }
    return {
        buffer: state.output || buffer,
        bounds: robustCoordinateBounds(state.coordinates),
        diagnostics: {
            gaussians: state.count,
            visible: state.visible,
            invalid: state.invalid,
            repaired: Boolean(state.output),
        },
    };
}

function abortError() {
    const error = new Error("SPLAT preparation was cancelled");
    error.name = "AbortError";
    return error;
}

async function yieldToMainThread() {
    if (globalThis.scheduler?.yield) {
        await globalThis.scheduler.yield();
        return;
    }
    await new Promise(resolve => setTimeout(resolve, 0));
}

export function prepareSplatBuffer(buffer, label = "SPLAT asset") {
    validateSplatBuffer(buffer, label);
    const source = new DataView(buffer);
    const state = splatScanState(buffer);
    scanSplatRange(buffer, source, state, 0, state.count);
    return splatScanResult(buffer, label, state);
}

export async function prepareSplatBufferAsync(
    buffer,
    label = "SPLAT asset",
    { signal, chunkRecords = SPLAT_SCAN_CHUNK } = {},
) {
    validateSplatBuffer(buffer, label);
    const source = new DataView(buffer);
    const state = splatScanState(buffer);
    const chunk = Math.max(1_024, Math.floor(Number(chunkRecords) || SPLAT_SCAN_CHUNK));
    for (let start = 0; start < state.count; start += chunk) {
        if (signal?.aborted) throw abortError();
        scanSplatRange(
            buffer,
            source,
            state,
            start,
            Math.min(state.count, start + chunk),
        );
        if (start + chunk < state.count) await yieldToMainThread();
    }
    if (signal?.aborted) throw abortError();
    return splatScanResult(buffer, label, state);
}

function paddedBounds(box) {
    if (!box || box.isEmpty()) return new THREE.Box3();
    const size = box.getSize(new THREE.Vector3());
    const largest = Math.max(size.x, size.y, size.z);
    box.expandByScalar(Math.max(largest * 0.025, 0.00001));
    return box;
}

function hasFiniteBounds(box) {
    return Boolean(
        box
        && !box.isEmpty()
        && [
            box.min.x,
            box.min.y,
            box.min.z,
            box.max.x,
            box.max.y,
            box.max.z,
        ].every(Number.isFinite),
    );
}

/**
 * Frame an untransformed TripoSplat object from its canonical front.
 *
 * triposplatCanonicalMatrix() makes the generated image plane face +Z, so the
 * preview camera is always placed on +Z and looks toward -Z. Scene position,
 * scene rotation, scene scale, and the interactive orbit camera are therefore
 * deliberately absent from this calculation.
 */
export function canonicalObjectPreviewCamera(
    bounds,
    width = 640,
    height = 640,
    fov = 42,
    padding = 1.12,
) {
    if (!hasFiniteBounds(bounds)) {
        throw new Error("The Gaussian object has no finite canonical preview bounds");
    }
    const targetWidth = Math.max(1, Number(width) || 640);
    const targetHeight = Math.max(1, Number(height) || 640);
    const safeFov = Math.max(5, Math.min(120, Number(fov) || 42));
    const safePadding = Math.max(1, Math.min(2, Number(padding) || 1.12));
    const center = bounds.getCenter(new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3());
    const verticalHalfFov = THREE.MathUtils.degToRad(safeFov * 0.5);
    const horizontalHalfFov = Math.atan(
        Math.tan(verticalHalfFov) * targetWidth / targetHeight,
    );
    const halfWidth = Math.max(size.x * 0.5 * safePadding, 0.00001);
    const halfHeight = Math.max(size.y * 0.5 * safePadding, 0.00001);
    const halfDepth = Math.max(size.z * 0.5, 0.00001);
    const faceDistance = Math.max(
        halfWidth / Math.tan(horizontalHalfFov),
        halfHeight / Math.tan(verticalHalfFov),
        0.001,
    );
    const distance = halfDepth + faceDistance;
    const radius = Math.max(size.length() * 0.5, 0.001);
    return {
        position: new THREE.Vector3(center.x, center.y, center.z + distance),
        target: center,
        up: new THREE.Vector3(0, 1, 0),
        fov: safeFov,
        near: Math.max(0.000001, faceDistance / 100000),
        far: Math.max(1000, distance + halfDepth + radius * 1000),
    };
}

/**
 * Build interaction bounds from visible Gaussian centers instead of their
 * covariance radii. A single nearly transparent Gaussian with a very large
 * scale must not make selection, framing, and transform controls unusable.
 */
export function computeRobustSplatBounds(mesh, options = {}) {
    const maxSamples = Math.max(256, Number(options.maxSamples) || SPLAT_BOUND_SAMPLES);
    const opacityThreshold = Math.max(0, Number(options.opacityThreshold) || 0.01);
    const splatCount = Math.max(0, Number(mesh?.numSplats) || 0);
    const stride = Math.max(1, Math.ceil(splatCount / maxSamples));
    const coordinates = [[], [], []];

    try {
        const splats = mesh?.splats;
        if (typeof splats?.getSplat === "function") {
            for (let index = 0; index < splatCount; index += stride) {
                const { center, opacity } = splats.getSplat(index);
                if (Number.isFinite(opacity) && opacity < opacityThreshold) continue;
                const x = Number(center?.x);
                const y = Number(center?.y);
                const z = Number(center?.z);
                if (![x, y, z].every(Number.isFinite)) continue;
                coordinates[0].push(x);
                coordinates[1].push(y);
                coordinates[2].push(z);
            }
        } else {
            mesh.forEachSplat((index, center, _scales, _quaternion, opacity) => {
                if (index % stride !== 0) return;
                if (Number.isFinite(opacity) && opacity < opacityThreshold) return;
                const x = Number(center?.x);
                const y = Number(center?.y);
                const z = Number(center?.z);
                if (![x, y, z].every(Number.isFinite)) return;
                coordinates[0].push(x);
                coordinates[1].push(y);
                coordinates[2].push(z);
            });
        }
    } catch (_) {}

    const sampled = robustCoordinateBounds(coordinates, options);
    if (hasFiniteBounds(sampled)) return sampled;

    try {
        const box = paddedBounds(mesh.getBoundingBox(true).clone());
        return hasFiniteBounds(box) ? box : new THREE.Box3();
    } catch (_) {
        return new THREE.Box3(
            new THREE.Vector3(-0.5, -0.5, -0.5),
            new THREE.Vector3(0.5, 0.5, 0.5),
        );
    }
}

function robustCoordinateBounds(coordinates, options = {}) {
    const trimFraction = Math.max(
        0,
        Math.min(0.02, Number(options.trimFraction) || 0.002),
    );
    const sampleCount = coordinates?.[0]?.length || 0;
    if (sampleCount < 8) return new THREE.Box3();
    for (const axis of coordinates) axis.sort((left, right) => left - right);
    const trim = sampleCount >= 128
        ? Math.min(
            Math.floor(sampleCount * trimFraction),
            Math.floor((sampleCount - 2) / 2),
        )
        : 0;
    const last = sampleCount - 1 - trim;
    return paddedBounds(new THREE.Box3(
        new THREE.Vector3(
            coordinates[0][trim],
            coordinates[1][trim],
            coordinates[2][trim],
        ),
        new THREE.Vector3(
            coordinates[0][last],
            coordinates[1][last],
            coordinates[2][last],
        ),
    ));
}

export function boundedObjectHit(ray, entries) {
    let nearest = null;
    const point = new THREE.Vector3();
    for (const [objectId, entry] of entries) {
        if (
            !entry?.mesh
            || entry.mesh.visible === false
            || !entry?.localBounds
            || entry.localBounds.isEmpty()
        ) continue;
        entry.mesh.updateMatrixWorld(true);
        const worldBounds = entry.localBounds.clone().applyMatrix4(entry.mesh.matrixWorld);
        if (!ray.intersectBox(worldBounds, point)) continue;
        const distance = ray.origin.distanceTo(point);
        if (!nearest || distance < nearest.distance) nearest = { objectId, distance };
    }
    return nearest;
}

export class Factory3DViewer {
    constructor(host, options = {}) {
        if (!host?.appendChild) throw new TypeError("Factory3DViewer requires a host element");
        this.host = host;
        this.options = {
            onSelectionChange: options.onSelectionChange || EMPTY,
            onTransformChange: options.onTransformChange || EMPTY,
            onStateChange: options.onStateChange || EMPTY,
            onLoadingChange: options.onLoadingChange || EMPTY,
            onError: options.onError || EMPTY,
            onArchitectureSelection: options.onArchitectureSelection || EMPTY,
            onArchitectureEdit: options.onArchitectureEdit || EMPTY,
            snapPlanPoint: options.snapPlanPoint || ((point) => point),
            onPlanGesture: options.onPlanGesture || EMPTY,
            onPlanHover: options.onPlanHover || EMPTY,
            resolveAssetURL: options.resolveAssetURL || (value => value),
        };
        this.objects = new Map();
        this.sceneData = null;
        this.selectedId = "";
        this.selectedGroupId = "";
        this.selectedGroupObjectIds = [];
        this.architectureSelection = null;
        this._groupTransformStart = null;
        this.mode = "translate";
        this.gridVisible = false;
        this.viewMode = "3d";
        this.planTool = "select";
        this.activeLevelId = "";
        this.planCameraState = { target: [0, 0], zoom: 24 };
        this.planGridState = { visible: true, step: 0.1, majorEvery: 10 };
        this._planGridSignature = "";
        this._planPan = null;
        this.captureWidth = 1024;
        this.captureHeight = 1024;
        this.captureFov = 42;
        this.cameraFrameVisible = false;
        this._capturing = false;
        this._disposed = false;
        this._loadingToken = 0;
        this._sceneSetSerial = Promise.resolve();
        this._loadController = null;
        this._suppressTransform = false;
        this._suppressStateEvents = false;
        this._frame = 0;
        this._renderRequested = false;
        this._lastRenderTime = 0;
        this._cameraStateDirty = false;
        this._viewportVisible = true;
        this._documentVisible = document.visibilityState !== "hidden";
        this._viewportWidth = 0;
        this._viewportHeight = 0;
        this._currentPixelRatio = 0;
        this._resizeObserver = null;
        this._intersectionObserver = null;
        this._visibilityHandler = null;
        this._interactionReasons = new Set();
        this._qualityInteractionReasons = new Set();
        this._interactiveQuality = false;
        this._qualityRestoreTimer = 0;
        this._lightingUpdateTimer = 0;
        this._pendingLightingEntries = new Set();
        this._lightingRigSignature = "";
        this.lighting = { ...DEFAULT_LIGHTING };
        this._lightColor = new THREE.Color(DEFAULT_LIGHTING.color);
        this._lightBaseGain = new THREE.Vector3(1, 1, 1);
        this._lightDirectionalScale = new THREE.Vector3();
        this.skydome = null;
        this.skydomeTexture = null;
        this.skydomeAssetPath = "";
        this._skydomeLoadToken = 0;
        this._lightSourceWorld = new THREE.Vector3();
        this._lightingCenterScratch = new THREE.Vector3();
        this._lightingSizeScratch = new THREE.Vector3();
        this._lightingQuaternionScratch = new THREE.Quaternion();
        this._setup();
    }

    _setup() {
        this.canvas = document.createElement("canvas");
        this.canvas.className = "vnccs-i3s__factory-canvas";
        this.canvas.tabIndex = 0;
        this.canvas.setAttribute(
            "aria-label",
            "3D scene. Drag to look around in place, use the mouse wheel to move forward or backward, or click an object to select it.",
        );
        Object.assign(this.canvas.style, {
            width: "100%",
            height: "100%",
            display: "block",
            touchAction: "none",
            outline: "none",
        });
        this.host.appendChild(this.canvas);
        this.cameraFrame = document.createElement("div");
        this.cameraFrame.className = "vnccs-i3s__camera-frame";
        this.cameraFrame.setAttribute("aria-hidden", "true");
        this.cameraFrameLabel = document.createElement("span");
        this.cameraFrame.appendChild(this.cameraFrameLabel);
        this.host.appendChild(this.cameraFrame);

        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color("#171b25");
        this.lightRig = new THREE.Group();
        this.lightRig.name = "VNCCS Factory lights";
        this.ambientLight = new THREE.AmbientLight("#ffffff", 0.5);
        this.sunLight = new THREE.DirectionalLight("#fff1d6", 0.72);
        this.sunLight.target.position.set(0, 0, 0);
        this.lightRig.add(this.ambientLight, this.sunLight, this.sunLight.target);
        this.scene.add(this.lightRig);
        this.camera = new THREE.PerspectiveCamera(42, 1, 0.0001, 100000);
        this.camera.position.set(2.8, 2.1, 4.2);
        this.planCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 10000);
        this.planCamera.position.set(0, 1000, 0);
        this.planCamera.up.set(0, 0, -1);
        this.planCamera.lookAt(0, 0, 0);
        this.captureCamera = new THREE.PerspectiveCamera(42, 1, 0.0001, 100000);

        this.renderer = new THREE.WebGLRenderer({
            canvas: this.canvas,
            antialias: false,
            alpha: false,
            depth: true,
            stencil: false,
            powerPreference: "high-performance",
        });
        this.renderer.outputColorSpace = THREE.SRGBColorSpace;
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        this._nativePixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);
        this.renderer.setPixelRatio(1);

        // Spark 2.x keeps sorting, frustum selection, and LoD traversal in
        // workers. Do not impose a fixed aggregate splat cap here: Spark's
        // platform-aware budget and screen-space tree traversal distribute
        // detail by projected importance across every object in the scene.
        // Every original Gaussian remains in the object and scene exports.
        this.spark = new SparkRenderer({
            renderer: this.renderer,
            maxStdDev: Math.sqrt(5),
            minSortIntervalMs: 32,
            lodRenderScale: 1,
            behindFoveate: 0.1,
            coneFov0: 100,
            coneFov: 145,
            coneFoveate: 0.35,
        });
        // Spark marks itself dirty again when worker-side sorting or mapping
        // finishes. That callback is what makes render-on-demand safe: a new
        // frame is requested only when the GPU output can actually change.
        this.spark.onDirty = () => this.invalidate();
        this.setLighting(this.lighting);
        this.scene.add(this.spark);
        this.architecture = new FactoryArchitectureRuntime(this.scene, {
            resolveTexture: textureId => new THREE.TextureLoader().loadAsync(
                this.options.resolveAssetURL(
                    `/vnccs/3d-factory/scenes/${encodeURIComponent(this.sceneData?.scene_id || "")}`
                    + `/textures/${encodeURIComponent(textureId)}`,
                ),
            ),
        });
        this.planOverlay = new THREE.Group();
        this.planOverlay.name = "VNCCS Factory plan overlay";
        this.planOverlay.visible = false;
        this.planGridRoot = new THREE.Group();
        this.planGridRoot.name = "VNCCS Factory plan grid";
        this.planGridMinor = this._createPlanGridLines("#575269", 0.34, 1);
        this.planGridMajor = this._createPlanGridLines("#8f82b4", 0.5, 2);
        this.planGridAxis = this._createPlanGridLines("#d7ccff", 0.72, 3);
        this.planGridRoot.add(this.planGridMinor, this.planGridMajor, this.planGridAxis);
        this.planDraftRoot = new THREE.Group();
        this.cameraMarkerRoot = new THREE.Group();
        this.lightMarkerRoot = new THREE.Group();
        this.architectureHandleRoot = new THREE.Group();
        this.planOverlay.add(
            this.planGridRoot,
            this.planDraftRoot,
            this.cameraMarkerRoot,
            this.lightMarkerRoot,
            this.architectureHandleRoot,
        );
        this.scene.add(this.planOverlay);

        this.controls = new OrbitControls(this.camera, this.canvas);
        this.controls.target.set(0, 0, 0);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.08;
        this.controls.enablePan = true;
        this.controls.enableZoom = true;
        // Viewport dragging is first-person look, not an implicit orbit around
        // the world origin. OrbitControls still owns dolly and middle-button
        // pan, while explicit framing commands choose a focus target.
        this.controls.enableRotate = false;
        this.controls.minDistance = 0.0001;
        this.controls.maxDistance = 1_000_000;
        this.controls.mouseButtons = {
            LEFT: THREE.MOUSE.ROTATE,
            MIDDLE: THREE.MOUSE.PAN,
            RIGHT: THREE.MOUSE.ROTATE,
        };
        this.controls.addEventListener("change", () => {
            this._updateClipPlanes();
            this._cameraStateDirty = !this._suppressStateEvents;
            this.invalidate();
        });
        this.controls.addEventListener("start", () => this._setInteractive("orbit", true));
        this.controls.addEventListener("end", () => this._setInteractive("orbit", false));

        this.grid = new THREE.GridHelper(20, 40, 0x826f9e, 0x343140);
        this.grid.material.transparent = true;
        this.grid.material.opacity = 0.28;
        this.grid.visible = this.gridVisible;
        this.scene.add(this.grid);

        this.transform = new TransformControls(this.camera, this.canvas);
        this.transformHelper = this.transform.getHelper();
        this.transformHelper.renderOrder = 10_000;
        this.transformHelper.traverse(child => {
            child.renderOrder = 10_000;
            const materials = Array.isArray(child.material) ? child.material : [child.material];
            for (const material of materials) {
                if (!material) continue;
                material.depthTest = false;
                material.depthWrite = false;
            }
        });
        this.scene.add(this.transformHelper);
        this.transform.setMode(this.mode);
        this.transform.setSpace("world");
        this.transform.setSize(0.9);

        this.selectionBounds = new THREE.Box3Helper(new THREE.Box3(), 0xff8fa3);
        this.selectionBounds.visible = false;
        this.selectionBounds.renderOrder = 9_999;
        this.selectionBounds.material.depthTest = false;
        this.selectionBounds.material.depthWrite = false;
        this.selectionBounds.material.transparent = true;
        this.selectionBounds.material.opacity = 0.72;
        this.scene.add(this.selectionBounds);
        this.groupPivot = new THREE.Group();
        this.groupPivot.name = "VNCCS Factory group transform pivot";
        this.scene.add(this.groupPivot);
        this.transform.addEventListener("dragging-changed", event => {
            this.controls.enabled = !event.value;
            this._setInteractive("transform", Boolean(event.value));
            if (event.value && this.selectedGroupId) this._beginGroupTransform();
            if (!event.value) {
                if (this.selectedGroupId) {
                    this._applyGroupTransform(true);
                    this._configureGroupPivot();
                } else {
                    const entry = this.selectedId ? this.objects.get(this.selectedId) : null;
                    if (entry) {
                        const transform = this._meshTransform(entry.mesh);
                        entry.data.transform = transform;
                        this.options.onTransformChange(this.selectedId, transform, {
                            final: true,
                            previous_transforms: this._singleTransformStart
                                ? { [this.selectedId]: this._singleTransformStart }
                                : {},
                        });
                    }
                    this._singleTransformStart = null;
                }
                this._flushDirectionalLighting();
                this._emitState();
            }
            this.invalidate();
        });
        this.transform.addEventListener("mouseDown", () => {
            if (this.selectedGroupId) {
                this._beginGroupTransform();
                this._scaleDragStart = 1;
            } else {
                const mesh = this.selectedId ? this.objects.get(this.selectedId)?.mesh : null;
                this._scaleDragStart = mesh ? mesh.scale.x : 1;
                this._singleTransformStart = mesh ? this._meshTransform(mesh) : null;
            }
        });
        this.transform.addEventListener("objectChange", () => this._onTransformObjectChange());

        this.raycaster = new THREE.Raycaster();
        this.pointer = new THREE.Vector2();
        this._pointerDown = null;
        this._planDraw = null;
        this._lookDrag = null;
        this.canvas.addEventListener("pointerdown", event => {
            try { this.canvas.focus({ preventScroll: true }); }
            catch (_) { this.canvas.focus(); }
            this._pointerDown = [event.clientX, event.clientY];
            if (
                this.viewMode === "3d"
                && (event.button === 0 || event.button === 2)
                && !this.transform.dragging
                && !this.transform.axis
            ) {
                this._lookDrag = {
                    pointerId: event.pointerId,
                    button: event.button,
                    x: event.clientX,
                    y: event.clientY,
                    originX: event.clientX,
                    originY: event.clientY,
                    moved: false,
                };
                this.canvas.setPointerCapture?.(event.pointerId);
                if (event.button === 2) event.preventDefault();
            }
            if (this.viewMode === "plan" && event.button === 0 && this.planTool !== "select") {
                const point = this.screenToPlan(event);
                this._planDraw = {
                    pointerId: event.pointerId,
                    tool: this.planTool,
                    originX: event.clientX,
                    originY: event.clientY,
                    moved: false,
                };
                this.canvas.setPointerCapture?.(event.pointerId);
                this.options.onPlanGesture({
                    phase: "start",
                    tool: this.planTool,
                    point,
                    event,
                    moved: false,
                    distance: 0,
                });
                event.preventDefault();
                return;
            }
            if (this.viewMode === "plan" && event.button === 0 && this.planTool === "select") {
                const handle = this._planHandleHit(event);
                if (handle) {
                    const wall = handle.userData.factoryHandleType === "wall"
                        ? this.sceneData?.architecture?.walls?.find(item => item.wall_id === handle.userData.factoryHandleId)
                        : null;
                    let fixedPoint = null;
                    if (wall) {
                        const other = handle.userData.endpoint === "start" ? wall.end : wall.start;
                        const position = new THREE.Vector3(other[0], 0, other[1]);
                        this.architecture.buildingRoots.get(wall.building_id)?.localToWorld(position);
                        fixedPoint = [position.x, position.z];
                    }
                    this._architectureDrag = {
                        type: handle.userData.factoryHandleType,
                        id: handle.userData.factoryHandleId,
                        endpoint: handle.userData.endpoint || "",
                        fixedPoint,
                        thickness: Number(wall?.thickness) || 0.12,
                        handle,
                        pointerId: event.pointerId,
                        originX: event.clientX,
                        originY: event.clientY,
                        moved: false,
                    };
                    this.canvas.setPointerCapture?.(event.pointerId);
                    if (this._architectureDrag.type === "room") {
                        this.canvas.style.cursor = "grabbing";
                        this.options.onArchitectureEdit({
                            phase: "start",
                            type: "room",
                            id: this._architectureDrag.id,
                            event,
                        });
                    }
                    event.preventDefault();
                    return;
                }
            }
            if (this.viewMode === "plan" && (event.button === 1 || event.button === 2)) {
                this._planPan = {
                    x: event.clientX,
                    y: event.clientY,
                    target: [...this.planCameraState.target],
                };
                this.canvas.setPointerCapture?.(event.pointerId);
                event.preventDefault();
            }
        });
        this.canvas.addEventListener("pointermove", event => {
            const drawing = this._planDraw;
            if (drawing && drawing.pointerId === event.pointerId && this.viewMode === "plan") {
                const distance = Math.hypot(
                    event.clientX - drawing.originX,
                    event.clientY - drawing.originY,
                );
                if (distance > 4) drawing.moved = true;
                this.options.onPlanGesture({
                    phase: "move",
                    tool: drawing.tool,
                    point: this.screenToPlan(event),
                    event,
                    moved: drawing.moved,
                    distance,
                });
                event.preventDefault();
                return;
            }
            const look = this._lookDrag;
            if (look && look.pointerId === event.pointerId && this.viewMode === "3d") {
                const deltaX = event.clientX - look.x;
                const deltaY = event.clientY - look.y;
                look.x = event.clientX;
                look.y = event.clientY;
                if (Math.hypot(event.clientX - look.originX, event.clientY - look.originY) > 3) {
                    look.moved = true;
                }
                if (look.moved && (deltaX || deltaY)) {
                    this.rotateCameraFPV(
                        { yaw: -deltaX * 0.18, pitch: -deltaY * 0.18 },
                        { emit: false },
                    );
                    this.canvas.style.cursor = "grabbing";
                    event.preventDefault();
                    return;
                }
            }
            if (this._architectureDrag) {
                const distance = Math.hypot(
                    event.clientX - this._architectureDrag.originX,
                    event.clientY - this._architectureDrag.originY,
                );
                if (distance > 3) this._architectureDrag.moved = true;
                const point = this.options.snapPlanPoint(
                    this.screenToPlan(event),
                    event,
                    { origin: this._architectureDrag.fixedPoint },
                );
                const level = this.sceneData?.levels?.find(item => item.level_id === this.activeLevelId);
                this._architectureDrag.handle.position.set(
                    point[0],
                    (Number(level?.elevation) || 0) + 0.055,
                    point[1],
                );
                this._architectureDrag.point = point;
                if (this._architectureDrag.fixedPoint) {
                    this.setPlanDraft({
                        tool: "wall",
                        points: [this._architectureDrag.fixedPoint],
                        cursor: point,
                        thickness: this._architectureDrag.thickness,
                    });
                }
                if (this._architectureDrag.type === "room" && this._architectureDrag.moved) {
                    this.options.onArchitectureEdit({
                        phase: "move",
                        type: "room",
                        id: this._architectureDrag.id,
                        point,
                        event,
                    });
                }
                this.invalidate();
                event.preventDefault();
                return;
            }
            if (this.viewMode === "plan" && this.planTool !== "select" && !this._planPan) {
                this.options.onPlanHover(this.planTool, this.screenToPlan(event), event);
            }
            if (this.viewMode !== "plan" || !this._planPan) return;
            const zoom = Math.max(0.01, this.planCameraState.zoom);
            this.planCameraState.target = [
                this._planPan.target[0] - (event.clientX - this._planPan.x) / zoom,
                this._planPan.target[1] - (event.clientY - this._planPan.y) / zoom,
            ];
            this._syncPlanCamera();
            this.invalidate();
            event.preventDefault();
        });
        this.canvas.addEventListener("pointerleave", event => {
            if (
                this.viewMode === "plan"
                && this.planTool !== "select"
                && !this._planPan
                && !this._architectureDrag
                && !this._planDraw
            ) {
                this.options.onPlanHover(this.planTool, null, event);
            }
        });
        this.canvas.addEventListener("pointerup", event => {
            const drawing = this._planDraw?.pointerId === event.pointerId ? this._planDraw : null;
            if (drawing) {
                const distance = Math.hypot(
                    event.clientX - drawing.originX,
                    event.clientY - drawing.originY,
                );
                drawing.moved = drawing.moved || distance > 4;
                this._planDraw = null;
                this._pointerDown = null;
                this.canvas.releasePointerCapture?.(event.pointerId);
                this.options.onPlanGesture({
                    phase: "end",
                    tool: drawing.tool,
                    point: this.screenToPlan(event),
                    event,
                    moved: drawing.moved,
                    distance,
                });
                event.preventDefault();
                return;
            }
            const look = this._lookDrag?.pointerId === event.pointerId ? this._lookDrag : null;
            if (look) {
                this._lookDrag = null;
                this.canvas.releasePointerCapture?.(event.pointerId);
                this.canvas.style.cursor = "default";
                if (look.moved) {
                    this._pointerDown = null;
                    this._cameraStateDirty = false;
                    this._emitState();
                    event.preventDefault();
                    return;
                }
            }
            if (this._architectureDrag) {
                const drag = this._architectureDrag;
                this._architectureDrag = null;
                this.setPlanDraft(null);
                this.canvas.releasePointerCapture?.(event.pointerId);
                if (drag.type === "room") this.canvas.style.cursor = "default";
                if (drag.type === "room" && !drag.moved) {
                    this.options.onArchitectureEdit({
                        phase: "cancel",
                        type: drag.type,
                        id: drag.id,
                        event,
                    });
                    return;
                }
                this.options.onArchitectureEdit({
                    phase: "end",
                    type: drag.type,
                    id: drag.id,
                    endpoint: drag.endpoint,
                    point: drag.point || this.screenToPlan(event),
                    event,
                });
                return;
            }
            if (this._planPan) {
                this._planPan = null;
                this.canvas.releasePointerCapture?.(event.pointerId);
                this._emitState();
                return;
            }
            if (!this._pointerDown || this.transform.dragging) return;
            const distance = Math.hypot(
                event.clientX - this._pointerDown[0],
                event.clientY - this._pointerDown[1],
            );
            this._pointerDown = null;
            if (distance > 4 || event.button !== 0) return;
            this._pick(event);
        });
        this.canvas.addEventListener("contextmenu", event => {
            if (this.viewMode === "plan" || this.viewMode === "3d") event.preventDefault();
        });
        const cancelLook = event => {
            if (this._planDraw && (event.pointerId === undefined || this._planDraw.pointerId === event.pointerId)) {
                const drawing = this._planDraw;
                this._planDraw = null;
                this._pointerDown = null;
                this.options.onPlanGesture({
                    phase: "cancel",
                    tool: drawing.tool,
                    point: null,
                    event,
                    moved: drawing.moved,
                    distance: 0,
                });
            }
            if (
                this._architectureDrag
                && (event.pointerId === undefined || this._architectureDrag.pointerId === event.pointerId)
            ) {
                const drag = this._architectureDrag;
                this._architectureDrag = null;
                this.setPlanDraft(null);
                if (drag.type === "room") this.canvas.style.cursor = "default";
                if (drag.type === "room") {
                    this.options.onArchitectureEdit({
                        phase: "cancel",
                        type: drag.type,
                        id: drag.id,
                        event,
                    });
                }
            }
            if (!this._lookDrag || (event.pointerId !== undefined && this._lookDrag.pointerId !== event.pointerId)) return;
            this._lookDrag = null;
            this._pointerDown = null;
            this.canvas.style.cursor = "default";
        };
        this.canvas.addEventListener("pointercancel", cancelLook);
        this.canvas.addEventListener("lostpointercapture", cancelLook);
        this.canvas.addEventListener("wheel", event => {
            if (this.viewMode === "3d") {
                this.dollyCamera(-event.deltaY / 100, { emit: true });
                event.preventDefault();
                event.stopImmediatePropagation();
                return;
            }
            if (this.viewMode !== "plan") return;
            const before = this.screenToPlan(event);
            const deltaScale = event.deltaMode === WheelEvent.DOM_DELTA_LINE
                ? 16
                : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
                    ? Math.max(1, this.host.clientHeight)
                    : 1;
            const wheelDelta = Math.max(-240, Math.min(240, event.deltaY * deltaScale));
            this.planCameraState.zoom = Math.max(
                0.01,
                Math.min(100000, this.planCameraState.zoom * Math.exp(-wheelDelta * 0.002)),
            );
            this._updatePlanProjection();
            const after = this.screenToPlan(event);
            this.planCameraState.target[0] += before[0] - after[0];
            this.planCameraState.target[1] += before[1] - after[1];
            this._syncPlanCamera();
            this._emitState();
            this.invalidate();
            event.preventDefault();
            event.stopImmediatePropagation();
        }, { capture: true, passive: false });
        this.canvas.addEventListener("keydown", event => {
            const mode = { w: "translate", e: "rotate", r: "scale" }[event.key.toLowerCase()];
            if (mode) {
                event.preventDefault();
                this.setMode(mode);
                return;
            }
        });

        this._resizeObserver = new ResizeObserver(() => this.resize());
        this._resizeObserver.observe(this.host);
        if (typeof IntersectionObserver !== "undefined") {
            this._intersectionObserver = new IntersectionObserver(entries => {
                const entry = entries[entries.length - 1];
                this._setViewportVisible(Boolean(entry?.isIntersecting));
            }, { rootMargin: "128px" });
            this._intersectionObserver.observe(this.host);
        }
        this._visibilityHandler = () => {
            this._documentVisible = document.visibilityState !== "hidden";
            if (this._documentVisible) {
                this.resize();
                this.invalidate();
            } else {
                this._cancelScheduledFrame();
            }
        };
        document.addEventListener("visibilitychange", this._visibilityHandler);
        this.resize();
        this.invalidate();
    }

    _canRenderViewport() {
        return Boolean(
            !this._disposed
            && !this._capturing
            && this._documentVisible
            && this._viewportVisible
            && this.host?.isConnected,
        );
    }

    _cancelScheduledFrame() {
        if (this._frame) cancelAnimationFrame(this._frame);
        this._frame = 0;
    }

    _setViewportVisible(visible) {
        const next = Boolean(visible);
        if (this._viewportVisible === next) return;
        this._viewportVisible = next;
        if (next) {
            this.resize();
            this.invalidate();
        } else {
            this._cancelScheduledFrame();
        }
    }

    invalidate() {
        if (this._disposed) return;
        this._renderRequested = true;
        if (this._frame || !this._canRenderViewport()) return;
        this._frame = requestAnimationFrame(time => this._renderFrame(time));
    }

    _renderFrame(time) {
        this._frame = 0;
        if (!this._canRenderViewport()) return;
        const interactive = this._interactiveQuality;
        if (
            interactive
            && this._lastRenderTime
            && time - this._lastRenderTime < INTERACTIVE_FRAME_MS
        ) {
            this.invalidate();
            return;
        }
        this._renderRequested = false;
        const deltaSeconds = this._lastRenderTime
            ? Math.min(0.1, Math.max(0, time - this._lastRenderTime) / 1000)
            : null;
        const cameraChanged = this.controls.update(deltaSeconds);
        this.renderer.render(this.scene, this.activeCamera());
        this._lastRenderTime = time;
        if (this._interactionReasons.size || cameraChanged || this._renderRequested) {
            this.invalidate();
            return;
        }
        if (this._cameraStateDirty) {
            this._cameraStateDirty = false;
            this._emitState();
        }
    }

    _attachDirectionalLighting(entry) {
        if (!entry?.splat || !entry?.splatBounds) return;
        const lightingModifier = createDirectionalLightingModifier();
        entry.lightingModifier = lightingModifier;
        entry.splat.objectModifier = lightingModifier.modifier;
        entry.splat.updateGenerator();
        this._syncDirectionalLighting(entry, { regenerate: false });
    }

    _attachShadowProxy(entry) {
        if (!entry?.mesh || !entry?.localBounds || entry.localBounds.isEmpty()) return;
        const center = entry.localBounds.getCenter(new THREE.Vector3());
        const size = entry.localBounds.getSize(new THREE.Vector3());
        const geometry = new THREE.BoxGeometry(
            Math.max(0.001, size.x),
            Math.max(0.001, size.y),
            Math.max(0.001, size.z),
        );
        geometry.translate(center.x, center.y, center.z);
        const material = new THREE.MeshBasicMaterial({
            colorWrite: false,
            depthWrite: false,
            transparent: true,
            opacity: 0,
        });
        const proxy = new THREE.Mesh(geometry, material);
        proxy.name = "VNCCS Gaussian shadow proxy";
        proxy.customDepthMaterial = new THREE.MeshDepthMaterial({
            depthPacking: THREE.RGBADepthPacking,
            side: THREE.DoubleSide,
        });
        proxy.castShadow = true;
        proxy.receiveShadow = false;
        proxy.userData.factoryShadowProxy = true;
        entry.mesh.add(proxy);
        entry.shadowProxy = proxy;
        this._syncShadowProxy(entry);
    }

    _syncShadowProxy(entry) {
        if (!entry?.shadowProxy) return;
        const transport = String(entry.data?.light_transport || "opaque");
        entry.shadowProxy.visible = Boolean(
            this.lighting.shadows?.enabled
            && this.lighting.shadows?.quality !== "off"
            && transport === "opaque",
        );
    }

    _disposeEntry(entry) {
        if (!entry) return;
        if (entry.shadowProxy) {
            entry.shadowProxy.geometry?.dispose?.();
            entry.shadowProxy.material?.dispose?.();
            entry.shadowProxy.customDepthMaterial?.dispose?.();
            entry.shadowProxy.parent?.remove(entry.shadowProxy);
            entry.shadowProxy = null;
        }
        entry.splat?.dispose?.();
    }

    _syncDirectionalLighting(entry, { regenerate = true } = {}) {
        const state = entry?.lightingModifier;
        if (!state || !entry?.mesh || !entry?.splat || !entry?.splatBounds) return;
        this._lightingCenterScratch ||= new THREE.Vector3();
        this._lightingSizeScratch ||= new THREE.Vector3();
        this._lightingQuaternionScratch ||= new THREE.Quaternion();
        entry.mesh.updateMatrixWorld(true);
        entry.splatBounds.getCenter(this._lightingCenterScratch);
        entry.splatBounds.getSize(this._lightingSizeScratch);
        state.objectCenter.value.copy(this._lightingCenterScratch);
        state.inverseHalfSize.value.set(
            2 / Math.max(this._lightingSizeScratch.x, 0.001),
            2 / Math.max(this._lightingSizeScratch.y, 0.001),
            2 / Math.max(this._lightingSizeScratch.z, 0.001),
        );
        entry.splat
            .getWorldQuaternion(this._lightingQuaternionScratch)
            .invert();
        // Keep the source fixed in world space like a sun. Only express that
        // same parallel direction in this SplatMesh's local coordinate frame.
        state.lightSource.value
            .copy(this._lightSourceWorld)
            .applyQuaternion(this._lightingQuaternionScratch)
            .normalize();
        state.baseGain.value.copy(this._lightBaseGain);
        state.directionalScale.value.copy(this._lightDirectionalScale);
        if (this.lighting.shadows?.enabled && this.lighting.shadows?.quality !== "off") {
            state.directionalScale.value.multiplyScalar(this._directionalVisibility(entry));
        }
        this._applyLocalLightGain(entry, state.baseGain.value);
        if (regenerate) entry.splat.updateVersion();
    }

    _directionalVisibility(targetEntry) {
        return this._visibilityAlongRay(targetEntry, this._lightSourceWorld, 1000000);
    }

    _visibilityAlongRay(targetEntry, directionValue, far = 1000000) {
        const bounds = targetEntry.localBounds?.clone().applyMatrix4(targetEntry.mesh.matrixWorld);
        if (!bounds || bounds.isEmpty()) return 1;
        const direction = directionValue.clone().normalize();
        const origin = bounds.getCenter(new THREE.Vector3())
            .addScaledVector(direction, 0.01);
        const ray = new THREE.Ray(origin, direction);
        let visibility = 1;
        for (const [objectId, entry] of this.objects) {
            if (entry === targetEntry || entry.mesh.visible === false) continue;
            const blocker = entry.localBounds?.clone().applyMatrix4(entry.mesh.matrixWorld);
            const intersection = blocker && !blocker.isEmpty()
                ? ray.intersectBox(blocker, new THREE.Vector3())
                : null;
            if (!intersection || intersection.distanceTo(origin) > far) continue;
            if (entry.data?.light_transport === "transmissive") {
                const transmission = Number(entry.data.transmission);
                visibility *= Math.max(0, Math.min(1, Number.isFinite(transmission) ? transmission : 1));
            } else if (entry.data?.light_transport === "cutout") {
                visibility *= 0.55;
            } else {
                return 0;
            }
            if (visibility <= 0.02) return 0;
        }
        const raycaster = new THREE.Raycaster(origin, direction, 0.01, far);
        const hits = raycaster.intersectObject(this.architecture?.root, true);
        for (const hit of hits) {
            if (hit.object.userData?.ignoreLightOcclusion) continue;
            const material = Array.isArray(hit.object.material)
                ? hit.object.material[hit.face?.materialIndex || 0]
                : hit.object.material;
            if (!material) continue;
            if (material.transmission > 0 || material.transparent) {
                const opacity = Number(material.opacity);
                visibility *= Math.max(
                    Number(material.transmission) || 0,
                    1 - (Number.isFinite(opacity) ? opacity : 1),
                );
            } else {
                return 0;
            }
            if (visibility <= 0.02) return 0;
        }
        return Math.max(0, Math.min(1, visibility));
    }

    _applyLocalLightGain(entry, target) {
        if (!this.lighting.lights?.length || !entry.localBounds) return;
        const center = entry.localBounds.clone().applyMatrix4(entry.mesh.matrixWorld)
            .getCenter(new THREE.Vector3());
        const shadowBudget = { low: 2, medium: 4, high: 6, ultra: 8 }[
            this.lighting.shadows?.quality
        ] || 0;
        let shadowCount = 0;
        for (const light of this.lighting.lights) {
            if (light.visible === false || light.intensity <= 0) continue;
            const owner = this.sceneData?.architecture?.buildings?.find(
                building => building.building_id === light.building_id,
            );
            if (owner?.visible === false) continue;
            if (
                light.level_id
                && entry.data?.level_id
                && light.level_id !== entry.data.level_id
            ) continue;
            const color = new THREE.Color(light.color);
            let response = light.intensity * 0.12;
            let lightDirection;
            let maximumDistance = 1000000;
            if (light.kind !== "directional") {
                const source = new THREE.Vector3().fromArray(light.position);
                const distance = center.distanceTo(source);
                if (light.distance > 0 && distance > light.distance) continue;
                if (light.kind === "spot") {
                    const spotDirection = new THREE.Vector3().fromArray(light.target).sub(source).normalize();
                    const toObject = center.clone().sub(source).normalize();
                    const cosine = spotDirection.dot(toObject);
                    const edge = Math.cos(THREE.MathUtils.degToRad(light.angle));
                    if (cosine < edge) continue;
                    const softness = Math.max(0.001, 1 - edge);
                    response *= Math.max(0, Math.min(1, (cosine - edge) / softness));
                }
                response /= Math.max(1, distance * distance);
                lightDirection = source.sub(center).normalize();
                maximumDistance = Math.max(0.01, distance - 0.02);
            } else {
                lightDirection = new THREE.Vector3().fromArray(light.position)
                    .sub(new THREE.Vector3().fromArray(light.target));
                if (lightDirection.lengthSq() < 1e-12) lightDirection.set(0, 1, 0);
                lightDirection.normalize();
            }
            if (
                light.cast_shadow
                && this.lighting.shadows?.enabled
                && this.lighting.shadows?.quality !== "off"
                && shadowCount < shadowBudget
            ) {
                response *= this._visibilityAlongRay(entry, lightDirection, maximumDistance);
                shadowCount += 1;
            }
            target.x += color.r * response;
            target.y += color.g * response;
            target.z += color.b * response;
        }
    }

    _syncThreeLights() {
        const qualitySizes = { low: 512, medium: 1024, high: 2048, ultra: 4096 };
        const shadowsEnabled = Boolean(
            this.lighting.shadows?.enabled && this.lighting.shadows?.quality !== "off",
        );
        this.ambientLight.intensity = this.lighting.preset === "off" ? 1 : this.lighting.ambient;
        this.sunLight.color.set(this.lighting.color);
        this.sunLight.intensity = this.lighting.preset === "off" ? 0 : this.lighting.intensity;
        this.sunLight.position.copy(this._lightSourceWorld).multiplyScalar(100);
        this.sunLight.castShadow = shadowsEnabled;
        const mapSize = qualitySizes[this.lighting.shadows?.quality] || 1024;
        this.sunLight.shadow.mapSize.set(mapSize, mapSize);
        this.sunLight.shadow.bias = this.lighting.shadows?.bias ?? -0.0005;
        this.sunLight.shadow.normalBias = this.lighting.shadows?.normal_bias ?? 0.02;
        this.sunLight.shadow.camera.left = -50;
        this.sunLight.shadow.camera.right = 50;
        this.sunLight.shadow.camera.top = 50;
        this.sunLight.shadow.camera.bottom = -50;
        for (const child of [...this.lightRig.children]) {
            if ([this.ambientLight, this.sunLight, this.sunLight.target].includes(child)) continue;
            this.lightRig.remove(child);
            child.shadow?.map?.dispose?.();
        }
        const shadowLightBudget = { low: 2, medium: 4, high: 6, ultra: 8 }[
            this.lighting.shadows?.quality
        ] || 0;
        let shadowLightCount = 0;
        for (const data of this.lighting.lights || []) {
            if (this.viewMode === "plan" && data.level_id && data.level_id !== this.activeLevelId) continue;
            const owner = this.sceneData?.architecture?.buildings?.find(
                building => building.building_id === data.building_id,
            );
            if (owner?.visible === false) continue;
            let light;
            if (data.kind === "spot") {
                light = new THREE.SpotLight(
                    data.color,
                    data.intensity,
                    data.distance,
                    THREE.MathUtils.degToRad(data.angle),
                    data.penumbra,
                );
            } else if (data.kind === "directional") {
                light = new THREE.DirectionalLight(data.color, data.intensity);
            } else {
                light = new THREE.PointLight(data.color, data.intensity, data.distance);
            }
            light.name = data.name || "Factory light";
            light.position.fromArray(data.position);
            light.visible = data.visible !== false;
            light.castShadow = Boolean(
                data.cast_shadow
                && shadowsEnabled
                && shadowLightCount < shadowLightBudget,
            );
            if (light.castShadow) shadowLightCount += 1;
            if (light.shadow) {
                light.shadow.mapSize.set(mapSize, mapSize);
                light.shadow.bias = this.lighting.shadows?.bias ?? -0.0005;
                light.shadow.normalBias = this.lighting.shadows?.normal_bias ?? 0.02;
                if (data.kind === "directional") {
                    light.shadow.camera.left = -25;
                    light.shadow.camera.right = 25;
                    light.shadow.camera.top = 25;
                    light.shadow.camera.bottom = -25;
                }
            }
            if (light.target) {
                light.target.position.fromArray(data.target);
                this.lightRig.add(light.target);
            }
            this.lightRig.add(light);
        }
    }

    _scheduleDirectionalLighting(entry, { immediate = false } = {}) {
        if (entry) this._pendingLightingEntries.add(entry);
        if (immediate) {
            this._flushDirectionalLighting();
            return;
        }
        if (this._lightingUpdateTimer) return;
        this._lightingUpdateTimer = setTimeout(
            () => this._flushDirectionalLighting(),
            LIGHTING_UPDATE_MS,
        );
    }

    _flushDirectionalLighting() {
        clearTimeout(this._lightingUpdateTimer);
        this._lightingUpdateTimer = 0;
        let regenerated = false;
        for (const entry of this._pendingLightingEntries) {
            if (!entry || !this.objects.has(entry.data?.object_id)) continue;
            this._syncDirectionalLighting(entry);
            regenerated = true;
        }
        this._pendingLightingEntries.clear();
        if (regenerated) this.spark?.setDirty?.();
        this.invalidate();
    }

    setLighting(value = {}) {
        this.lighting = normalizedLighting({ ...DEFAULT_LIGHTING, ...value });
        this.setLightMarkers?.(this.lighting.lights || []);
        lightSourceDirection(
            this.lighting.azimuth,
            this.lighting.elevation,
            this._lightSourceWorld,
        );
        this._lightColor.set(this.lighting.color);
        // Preserve the original color equation, split into a constant CPU-side
        // term and a small directional GPU correction.
        this._lightBaseGain.set(
            this.lighting.ambient
                + this._lightColor.r * this.lighting.intensity * LIGHTING_BASE_RESPONSE,
            this.lighting.ambient
                + this._lightColor.g * this.lighting.intensity * LIGHTING_BASE_RESPONSE,
            this.lighting.ambient
                + this._lightColor.b * this.lighting.intensity * LIGHTING_BASE_RESPONSE,
        );
        this._lightDirectionalScale.set(
            this._lightColor.r * this.lighting.intensity,
            this._lightColor.g * this.lighting.intensity,
            this._lightColor.b * this.lighting.intensity,
        );
        if (this.lighting.preset === "off") {
            this._lightBaseGain.set(1, 1, 1);
            this._lightDirectionalScale.set(0, 0, 0);
        }
        const rigSignature = JSON.stringify(this.lighting);
        if (rigSignature !== this._lightingRigSignature) {
            this._syncThreeLights();
            this._lightingRigSignature = rigSignature;
        }
        let regenerated = false;
        for (const entry of this.objects.values()) {
            this._syncShadowProxy(entry);
            this._syncDirectionalLighting(entry);
            regenerated = true;
        }
        if (regenerated) this.spark?.setDirty?.();
        this._applySkydomeSettings();
        this.invalidate();
    }

    _applySkydomeSettings() {
        if (!this.scene) return;
        if (this.skydomeTexture && this.skydome?.visible !== false) {
            this.scene.background = this.skydomeTexture;
            this.scene.backgroundRotation?.set(
                radians(this.skydome.pitch),
                radians(this.skydome.yaw),
                radians(this.skydome.roll),
                "YXZ",
            );
            this.scene.backgroundIntensity = 2 ** this.skydome.exposure;
            this.scene.backgroundBlurriness = this.skydome.blur;
        } else {
            if (this.scene.background?.isColor) {
                this.scene.background.set(this.lighting.background);
            } else {
                this.scene.background = new THREE.Color(this.lighting.background);
            }
            this.scene.backgroundRotation?.set(0, 0, 0);
            this.scene.backgroundIntensity = 1;
            this.scene.backgroundBlurriness = 0;
        }
        this.invalidate();
    }

    async _loadSkydomeTexture(assetPath) {
        const texture = await new THREE.TextureLoader().loadAsync(
            this.options.resolveAssetURL(assetPath),
        );
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.mapping = THREE.EquirectangularReflectionMapping;
        texture.anisotropy = Math.min(
            2,
            this.renderer?.capabilities?.getMaxAnisotropy?.() || 1,
        );
        texture.needsUpdate = true;
        return texture;
    }

    async setSkydome(value = null) {
        const token = ++this._skydomeLoadToken;
        this.skydome = value?.url ? normalizedSkydome(value) : null;
        const assetPath = String(this.skydome?.url || "");
        if (!assetPath) {
            this.skydomeAssetPath = "";
            this.skydomeTexture?.dispose?.();
            this.skydomeTexture = null;
            this._applySkydomeSettings();
            return null;
        }
        if (assetPath === this.skydomeAssetPath && this.skydomeTexture) {
            this._applySkydomeSettings();
            return this.skydome;
        }
        try {
            const texture = await this._loadSkydomeTexture(assetPath);
            if (token !== this._skydomeLoadToken || this._disposed) {
                texture.dispose();
                return null;
            }
            this.skydomeTexture?.dispose?.();
            this.skydomeTexture = texture;
            this.skydomeAssetPath = assetPath;
            this._applySkydomeSettings();
            this.invalidate();
            return this.skydome;
        } catch (error) {
            if (token !== this._skydomeLoadToken || this._disposed) return null;
            this.skydomeAssetPath = "";
            this.skydomeTexture?.dispose?.();
            this.skydomeTexture = null;
            this._applySkydomeSettings();
            this.options.onError(
                new Error(`Skydome image could not be loaded: ${error?.message || error}`),
            );
            return null;
        }
    }

    updateSkydome(value = null) {
        if (!value || !this.skydome) return;
        this.skydome = normalizedSkydome({ ...this.skydome, ...value });
        this._applySkydomeSettings();
    }

    hasVisibleSkydome() {
        return Boolean(this.skydomeTexture && this.skydome?.visible !== false);
    }

    isViewportVisible() {
        return Boolean(this._viewportVisible && this._documentVisible && this.host?.isConnected);
    }

    setEditorInteraction(reason, active) {
        const key = String(reason || "control");
        if (active) {
            this._qualityInteractionReasons.add(key);
            this._beginInteractiveQuality();
        } else if (this._qualityInteractionReasons.delete(key)) {
            this._scheduleQualityRestore();
        }
        this.invalidate();
    }

    _beginInteractiveQuality() {
        clearTimeout(this._qualityRestoreTimer);
        this._qualityRestoreTimer = 0;
        if (!this._interactiveQuality) {
            this._interactiveQuality = true;
            this.resize();
        }
    }

    _scheduleQualityRestore() {
        if (
            !this._interactiveQuality
            || this._interactionReasons.size
            || this._qualityInteractionReasons.size
            || this._qualityRestoreTimer
        ) return;
        // Restoring a large high-DPI drawing buffer directly inside pointerup
        // increases INP. Keep the lightweight buffer through damping, then
        // draw one sharp idle frame.
        this._qualityRestoreTimer = setTimeout(() => {
            this._qualityRestoreTimer = 0;
            if (
                this._disposed
                || this._interactionReasons.size
                || this._qualityInteractionReasons.size
            ) return;
            this._interactiveQuality = false;
            if (!this._documentVisible || !this._viewportVisible) return;
            this.resize();
            this.invalidate();
        }, 180);
    }

    _setInteractive(reason, active) {
        if (active) {
            this._interactionReasons.add(reason);
            this._beginInteractiveQuality();
        } else if (this._interactionReasons.delete(reason)) {
            this._scheduleQualityRestore();
        }
        this.invalidate();
    }

    _totalGaussianCount() {
        let total = 0;
        for (const entry of this.objects?.values?.() || []) {
            if (entry.mesh?.visible !== false) total += Number(entry.splat?.numSplats) || 0;
        }
        return total;
    }

    _createPlanGridLines(color, opacity, renderOrder) {
        const lines = new THREE.LineSegments(
            new THREE.BufferGeometry(),
            new THREE.LineBasicMaterial({
                color,
                transparent: true,
                opacity,
                depthTest: false,
                depthWrite: false,
                toneMapped: false,
            }),
        );
        lines.name = "VNCCS Factory plan grid lines";
        lines.renderOrder = renderOrder;
        lines.frustumCulled = false;
        // The grid is an editor guide, never an architecture selection target.
        lines.raycast = EMPTY;
        return lines;
    }

    _setPlanGridGeometry(lines, positions) {
        const previous = lines.geometry;
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
        lines.geometry = geometry;
        previous?.dispose?.();
    }

    _syncPlanGrid() {
        if (!this.planGridRoot || !this.planCamera) return;
        const state = this.planGridState || {};
        this.planGridRoot.visible = state.visible !== false;
        if (!this.planGridRoot.visible) return;

        const targetX = Number(this.planCameraState.target?.[0]) || 0;
        const targetZ = Number(this.planCameraState.target?.[1]) || 0;
        const width = Math.max(0.001, this.planCamera.right - this.planCamera.left);
        const depth = Math.max(0.001, this.planCamera.top - this.planCamera.bottom);
        const configuredStep = Math.max(0.001, Math.min(1000, Number(state.step) || 0.1));
        let displayStep = configuredStep;
        while (
            width / displayStep > MAX_PLAN_GRID_LINES_PER_AXIS
            || depth / displayStep > MAX_PLAN_GRID_LINES_PER_AXIS
        ) {
            displayStep *= 10;
        }
        const majorEvery = Math.max(2, Math.min(100, Math.round(Number(state.majorEvery) || 10)));
        const level = this.sceneData?.levels?.find(item => item.level_id === this.activeLevelId);
        const elevation = Number(level?.elevation) || 0;
        const minX = targetX + this.planCamera.left - displayStep;
        const maxX = targetX + this.planCamera.right + displayStep;
        const minZ = targetZ - depth * 0.5 - displayStep;
        const maxZ = targetZ + depth * 0.5 + displayStep;
        const startX = Math.floor(minX / displayStep);
        const endX = Math.ceil(maxX / displayStep);
        const startZ = Math.floor(minZ / displayStep);
        const endZ = Math.ceil(maxZ / displayStep);
        const signature = [
            startX,
            endX,
            startZ,
            endZ,
            elevation,
            configuredStep,
            displayStep,
            majorEvery,
        ].map(value => Number(value).toPrecision(12)).join("|");
        if (signature === this._planGridSignature) return;
        this._planGridSignature = signature;
        this.planGridRoot.position.y = elevation + 0.035;

        const minor = [];
        const major = [];
        const axis = [];
        const append = (positions, ax, az, bx, bz) => {
            positions.push(ax, 0, az, bx, 0, bz);
        };
        const selectBucket = index => {
            if (index === 0) return axis;
            return Math.abs(index) % majorEvery === 0 ? major : minor;
        };
        const gridMinX = startX * displayStep;
        const gridMaxX = endX * displayStep;
        const gridMinZ = startZ * displayStep;
        const gridMaxZ = endZ * displayStep;
        for (let index = startX; index <= endX; index += 1) {
            const x = index * displayStep;
            append(selectBucket(index), x, gridMinZ, x, gridMaxZ);
        }
        for (let index = startZ; index <= endZ; index += 1) {
            const z = index * displayStep;
            append(selectBucket(index), gridMinX, z, gridMaxX, z);
        }
        this._setPlanGridGeometry(this.planGridMinor, minor);
        this._setPlanGridGeometry(this.planGridMajor, major);
        this._setPlanGridGeometry(this.planGridAxis, axis);
    }

    _desiredPixelRatio(width, height) {
        const interactive = Boolean(this._interactiveQuality);
        const heavy = this._totalGaussianCount() >= HEAVY_SCENE_GAUSSIANS;
        const nativeRatio = Number.isFinite(this._nativePixelRatio)
            ? this._nativePixelRatio
            : 1;
        const base = interactive
            ? Math.min(nativeRatio, heavy ? 0.85 : 1)
            : nativeRatio;
        const pixelBudget = interactive
            ? (heavy ? 900_000 : 1_250_000)
            : 2_200_000;
        const budgetRatio = Math.sqrt(pixelBudget / Math.max(1, width * height));
        return Math.max(0.5, Math.min(base, budgetRatio));
    }

    resize() {
        if (this._disposed) return;
        // getBoundingClientRect() is expressed in post-transform screen
        // pixels. ComfyUI scales DOM widgets together with graph zoom, while
        // the frame's absolute left/top/width/height remain local CSS
        // coordinates. Mixing those spaces makes the frame shrink and drift
        // toward the top-left after zooming the graph. clientWidth/Height are
        // the untransformed containing-block dimensions shared by the canvas
        // and the frame.
        const rect = this.host.getBoundingClientRect();
        const width = Math.max(
            1,
            Math.floor(Number(this.host.clientWidth) || rect.width),
        );
        const height = Math.max(
            1,
            Math.floor(Number(this.host.clientHeight) || rect.height),
        );
        const pixelRatio = this._desiredPixelRatio(width, height);
        const sizeChanged = width !== this._viewportWidth || height !== this._viewportHeight;
        const currentPixelRatio = Number.isFinite(this._currentPixelRatio)
            ? this._currentPixelRatio
            : pixelRatio;
        const ratioChanged = Math.abs(pixelRatio - currentPixelRatio) > 1e-4;
        this._updateCameraProjection(width, height);
        this._updatePlanProjection(width, height);
        this._updateCameraFrame(width, height);
        if (ratioChanged) {
            this.renderer.setPixelRatio(pixelRatio);
            this._currentPixelRatio = pixelRatio;
        }
        if (sizeChanged) {
            this.renderer.setSize(width, height, false);
            this._viewportWidth = width;
            this._viewportHeight = height;
        }
        if (sizeChanged || ratioChanged) this.invalidate();
    }

    _cameraFrameLayout(width = 0, height = 0) {
        const viewWidth = Math.max(1, Number(width) || this.host.clientWidth || 1);
        const viewHeight = Math.max(1, Number(height) || this.host.clientHeight || 1);
        const captureAspect = this.captureWidth / Math.max(1, this.captureHeight);
        const minimumSide = Math.min(viewWidth, viewHeight);
        const safeInset = Math.min(
            Math.max(0, (minimumSide - 1) * 0.5),
            Math.min(56, Math.max(18, Math.round(minimumSide * 0.065))),
        );
        const availableWidth = Math.max(1, viewWidth - safeInset * 2);
        const availableHeight = Math.max(1, viewHeight - safeInset * 2);
        let frameWidth = availableWidth;
        let frameHeight = frameWidth / captureAspect;
        if (frameHeight > availableHeight) {
            frameHeight = availableHeight;
            frameWidth = frameHeight * captureAspect;
        }
        return {
            viewWidth,
            viewHeight,
            width: Math.max(1, frameWidth),
            height: Math.max(1, frameHeight),
            left: Math.max(0, (viewWidth - frameWidth) * 0.5),
            top: Math.max(0, (viewHeight - frameHeight) * 0.5),
            safeInset,
        };
    }

    _updateCameraProjection(width = 0, height = 0) {
        const layout = this._cameraFrameLayout(width, height);
        const viewAspect = layout.viewWidth / layout.viewHeight;
        let editorFov = this.captureFov;
        if (this.cameraFrameVisible) {
            const frameHeightFraction = Math.max(
                1e-6,
                Math.min(1, layout.height / layout.viewHeight),
            );
            editorFov = degrees(
                2 * Math.atan(
                    Math.tan(radians(this.captureFov) * 0.5) / frameHeightFraction,
                ),
            );
        }
        this.camera.aspect = viewAspect;
        this.camera.fov = Math.max(5, Math.min(175, editorFov));
        this.camera.updateProjectionMatrix();
    }

    _updatePlanProjection(width = 0, height = 0) {
        const viewWidth = Math.max(1, Number(width) || this.host.clientWidth || 1);
        const viewHeight = Math.max(1, Number(height) || this.host.clientHeight || 1);
        const zoom = Math.max(0.01, Number(this.planCameraState.zoom) || 24);
        this.planCamera.left = -viewWidth / (2 * zoom);
        this.planCamera.right = viewWidth / (2 * zoom);
        this.planCamera.top = viewHeight / (2 * zoom);
        this.planCamera.bottom = -viewHeight / (2 * zoom);
        this.planCamera.updateProjectionMatrix();
        this._syncPlanCamera();
    }

    _syncPlanCamera() {
        const [x, z] = this.planCameraState.target;
        const level = this.sceneData?.levels?.find(item => item.level_id === this.activeLevelId);
        const elevation = Number(level?.elevation) || 0;
        this.planCamera.position.set(x, elevation + 1000, z);
        this.planCamera.lookAt(x, elevation, z);
        this.planCamera.updateMatrixWorld(true);
        this._syncPlanGrid();
    }

    activeCamera() {
        return this.viewMode === "plan" ? this.planCamera : this.camera;
    }

    screenToPlan(event) {
        const rect = this.canvas.getBoundingClientRect();
        const point = new THREE.Vector3(
            ((event.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1,
            -((event.clientY - rect.top) / Math.max(1, rect.height)) * 2 + 1,
            0,
        ).unproject(this.planCamera);
        return [Number(point.x.toFixed(6)), Number(point.z.toFixed(6))];
    }

    _updateCameraFrame(width = 0, height = 0) {
        if (!this.cameraFrame) return;
        const layout = this._cameraFrameLayout(width, height);
        Object.assign(this.cameraFrame.style, {
            display: this.viewMode === "3d" && this.cameraFrameVisible ? "block" : "none",
            left: `${layout.left}px`,
            top: `${layout.top}px`,
            width: `${layout.width}px`,
            height: `${layout.height}px`,
        });
        this.cameraFrameLabel.textContent = `${this.captureWidth} × ${this.captureHeight}`;
    }

    _pick(event) {
        const rect = this.canvas.getBoundingClientRect();
        this.pointer.set(
            ((event.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1,
            -((event.clientY - rect.top) / Math.max(1, rect.height)) * 2 + 1,
        );
        this.raycaster.setFromCamera(this.pointer, this.activeCamera());
        const editorHits = [
            ...this.raycaster.intersectObject(this.planOverlay, true),
            ...this.raycaster.intersectObject(this.architecture.root, true),
        ].sort((left, right) => left.distance - right.distance);
        const architectureHit = editorHits.find(hit => hit.object?.userData?.factoryId);
        // Per-Gaussian raycasting creates long pointer tasks on dense scenes.
        // Robust trimmed bounds already describe every object well enough for
        // editor selection and keep this operation O(number of objects).
        const hit = boundedObjectHit(this.raycaster.ray, this.objects);
        if (architectureHit && (!hit || architectureHit.distance < hit.distance)) {
            this.select("");
            this.options.onArchitectureSelection({
                type: architectureHit.object.userData.factoryType,
                id: architectureHit.object.userData.factoryId,
                wallId: architectureHit.object.userData.wallId || "",
            });
            return;
        }
        if (hit?.objectId) this.select(hit.objectId, { additive: event.shiftKey });
    }

    _applyTransform(mesh, value) {
        const transform = normalizedTransform(value);
        this._suppressTransform = true;
        mesh.position.fromArray(transform.position);
        mesh.rotation.set(
            radians(transform.rotation[0]),
            radians(transform.rotation[1]),
            radians(transform.rotation[2]),
            "XYZ",
        );
        mesh.scale.setScalar(transform.scale);
        mesh.updateMatrixWorld(true);
        this._suppressTransform = false;
        if (mesh === this.objects.get(this.selectedId)?.mesh) this._refreshSelectionBounds();
    }

    _meshTransform(mesh) {
        const scalar = Math.max(0.001, Math.min(1000, (mesh.scale.x + mesh.scale.y + mesh.scale.z) / 3));
        return {
            position: mesh.position.toArray().map(value => Number(value.toFixed(6))),
            rotation: [
                degrees(mesh.rotation.x),
                degrees(mesh.rotation.y),
                degrees(mesh.rotation.z),
            ].map(value => Number(value.toFixed(4))),
            scale: Number(scalar.toFixed(6)),
        };
    }

    _onTransformObjectChange() {
        if (this._suppressTransform) return;
        if (this.selectedGroupId) {
            if (this.mode === "scale") {
                const values = [this.groupPivot.scale.x, this.groupPivot.scale.y, this.groupPivot.scale.z];
                const scalar = Math.max(0.001, Math.min(1000, values.reduce(
                    (chosen, value) => Math.abs(value - 1) > Math.abs(chosen - 1) ? value : chosen,
                    values[0],
                )));
                this._suppressTransform = true;
                this.groupPivot.scale.setScalar(scalar);
                this._suppressTransform = false;
            }
            this._applyGroupTransform(!this.transform.dragging);
            return;
        }
        if (!this.selectedId) return;
        const entry = this.objects.get(this.selectedId);
        if (!entry) return;
        if (this.mode === "scale") {
            const values = [entry.mesh.scale.x, entry.mesh.scale.y, entry.mesh.scale.z];
            const origin = Number(this._scaleDragStart) || 1;
            const scalar = Math.max(0.001, Math.min(1000, values.reduce(
                (chosen, value) => Math.abs(value - origin) > Math.abs(chosen - origin) ? value : chosen,
                values[0],
            )));
            this._suppressTransform = true;
            entry.mesh.scale.setScalar(scalar);
            this._suppressTransform = false;
        }
        const transform = this._meshTransform(entry.mesh);
        entry.data.transform = transform;
        this._refreshSelectionBounds();
        if (this.mode === "rotate") this._scheduleDirectionalLighting(entry);
        this.spark.setDirty?.();
        this.invalidate();
        this.options.onTransformChange(this.selectedId, transform, {
            final: !this.transform.dragging,
            previous_transforms: this._singleTransformStart
                ? { [this.selectedId]: this._singleTransformStart }
                : {},
        });
    }

    _groupEntries() {
        return this.selectedGroupObjectIds
            .map(objectId => [objectId, this.objects.get(objectId)])
            .filter(([, entry]) => Boolean(entry) && entry.data?.locked !== true);
    }

    _groupWorldBounds() {
        const box = new THREE.Box3();
        for (const [, entry] of this._groupEntries()) {
            try {
                entry.mesh.updateMatrixWorld(true);
                box.union(entry.localBounds.clone().applyMatrix4(entry.mesh.matrixWorld));
            } catch (_) {}
        }
        return box;
    }

    _configureGroupPivot() {
        if (!this.selectedGroupId) return;
        const box = this._groupWorldBounds();
        if (box.isEmpty()) {
            this.transform.detach();
            this.selectionBounds.visible = false;
            return;
        }
        this._suppressTransform = true;
        this.groupPivot.position.copy(box.getCenter(new THREE.Vector3()));
        this.groupPivot.quaternion.identity();
        this.groupPivot.scale.setScalar(1);
        this.groupPivot.updateMatrixWorld(true);
        this._suppressTransform = false;
        this._groupTransformStart = null;
        this.transform.attach(this.groupPivot);
        this._refreshSelectionBounds();
    }

    _beginGroupTransform() {
        if (!this.selectedGroupId || this._groupTransformStart) return;
        this.groupPivot.updateMatrixWorld(true);
        const pivotMatrix = this.groupPivot.matrixWorld.clone();
        const inversePivot = pivotMatrix.clone().invert();
        const objects = new Map();
        const previousTransforms = {};
        for (const [objectId, entry] of this._groupEntries()) {
            entry.mesh.updateMatrixWorld(true);
            objects.set(objectId, entry.mesh.matrixWorld.clone());
            previousTransforms[objectId] = this._meshTransform(entry.mesh);
        }
        this._groupTransformStart = { pivotMatrix, inversePivot, objects, previousTransforms };
    }

    _applyGroupTransform(final = false) {
        if (!this.selectedGroupId) return;
        this._beginGroupTransform();
        const baseline = this._groupTransformStart;
        if (!baseline) return;
        this.groupPivot.updateMatrixWorld(true);
        const delta = this.groupPivot.matrixWorld.clone().multiply(baseline.inversePivot);
        const position = new THREE.Vector3();
        const quaternion = new THREE.Quaternion();
        const scale = new THREE.Vector3();
        const baselineEntries = Array.from(baseline.objects.entries());
        for (const [entryIndex, [objectId, original]] of baselineEntries.entries()) {
            const entry = this.objects.get(objectId);
            if (!entry) continue;
            const matrix = delta.clone().multiply(original);
            matrix.decompose(position, quaternion, scale);
            const scalar = Math.max(
                0.001,
                Math.min(1000, (Math.abs(scale.x) + Math.abs(scale.y) + Math.abs(scale.z)) / 3),
            );
            this._suppressTransform = true;
            entry.mesh.position.copy(position);
            entry.mesh.quaternion.copy(quaternion).normalize();
            entry.mesh.scale.setScalar(scalar);
            entry.mesh.updateMatrixWorld(true);
            this._suppressTransform = false;
            const transform = this._meshTransform(entry.mesh);
            entry.data.transform = transform;
            if (this.mode === "rotate") this._scheduleDirectionalLighting(entry);
            this.options.onTransformChange(objectId, transform, {
                final,
                group_id: this.selectedGroupId,
                previous_transforms: baseline.previousTransforms,
                command_last: entryIndex === baselineEntries.length - 1,
            });
        }
        this._refreshSelectionBounds();
        if (final && this.mode === "rotate") this._flushDirectionalLighting();
        this.spark.setDirty?.();
        this.invalidate();
        if (final) {
            this._groupTransformStart = null;
            this._singleTransformStart = null;
        }
    }

    _refreshSelectionBounds() {
        if (this.selectedGroupId) {
            const box = this._groupWorldBounds();
            if (box.isEmpty()) {
                this.selectionBounds.visible = false;
                this.selectionBounds.box.makeEmpty();
                return;
            }
            this.selectionBounds.box.copy(box);
            this.selectionBounds.visible = true;
            this.selectionBounds.updateMatrixWorld(true);
            return;
        }
        const entry = this.selectedId ? this.objects.get(this.selectedId) : null;
        if (!entry?.localBounds || entry.localBounds.isEmpty()) {
            this.selectionBounds.visible = false;
            this.selectionBounds.box.makeEmpty();
            return;
        }
        entry.mesh.updateMatrixWorld(true);
        this.selectionBounds.box.copy(entry.localBounds).applyMatrix4(entry.mesh.matrixWorld);
        this.selectionBounds.visible = true;
        this.selectionBounds.updateMatrixWorld(true);
    }

    setScene(sceneData, options = {}) {
        const operation = this._sceneSetSerial.then(
            () => this._setSceneNow(sceneData, options),
        );
        this._sceneSetSerial = operation.catch(() => null);
        return operation;
    }

    async _setSceneNow(sceneData, { incremental = false } = {}) {
        if (this._disposed) return { loaded: 0, failures: [] };
        const previousCount = this.objects.size;
        const token = incremental
            ? (this._loadingToken || ++this._loadingToken)
            : ++this._loadingToken;
        if (!incremental) this._loadController?.abort();
        const loadController = new AbortController();
        this._loadController = loadController;
        this.sceneData = sceneData || { objects: [] };
        this.activeLevelId = this.activeLevelId || this.sceneData.levels?.[0]?.level_id || "";
        await this.architecture.set(this.sceneData);
        if (this._disposed) return { loaded: 0, failures: [] };
        this.architecture.sceneData = this.sceneData;
        this.architecture.setActiveLevel(this.activeLevelId, this.viewMode === "plan");
        this.setCameraMarkers(this.sceneData.cameras || []);
        this.setLighting(this.sceneData.lighting);
        const skydomePromise = this.setSkydome(this.sceneData.skydome);
        const source = Array.isArray(sceneData?.objects) ? sceneData.objects : [];
        const needsAssetLoading = !incremental || source.some(item => {
            const entry = this.objects.get(item.object_id);
            return !entry || entry.assetPath !== item.urls?.splat;
        });
        this.options.onLoadingChange(needsAssetLoading);
        if (!incremental) {
            this.transform.detach();
            this.selectionBounds.visible = false;
            this.selectedGroupId = "";
            this.selectedGroupObjectIds = [];
            for (const entry of this.objects.values()) {
                this.scene.remove(entry.mesh);
                this._disposeEntry(entry);
            }
            this.objects.clear();
        }

        const sourceIds = new Set(source.map(item => item.object_id));
        if (incremental) {
            for (const [objectId, entry] of this.objects) {
                if (sourceIds.has(objectId)) continue;
                if (objectId === this.selectedId) this.selectedId = "";
                this.selectedGroupObjectIds = this.selectedGroupObjectIds.filter(id => id !== objectId);
                this.scene.remove(entry.mesh);
                this._disposeEntry(entry);
                this.objects.delete(objectId);
            }
        }
        const visibleIds = effectiveVisibleObjectIds(sceneData);
        const failures = [];
        for (const item of source) {
            if (token !== this._loadingToken || this._disposed) return;
            let mesh = null;
            let objectRoot = null;
            try {
                const assetPath = item.urls?.splat;
                if (!assetPath) throw new Error(`Object ${item.object_id} has no SPLAT asset URL`);
                const existing = this.objects.get(item.object_id);
                if (existing?.assetPath === assetPath) {
                    existing.data = item;
                    existing.mesh.name = item.name || item.object_id;
                    existing.splat.name = item.name || item.object_id;
                    existing.mesh.visible = visibleIds.has(item.object_id);
                    this._applyTransform(existing.mesh, item.transform);
                    this._syncShadowProxy(existing);
                    this._syncDirectionalLighting(existing);
                    continue;
                }
                if (existing) {
                    this.scene.remove(existing.mesh);
                    this._disposeEntry(existing);
                    this.objects.delete(item.object_id);
                }
                const assetURL = this.options.resolveAssetURL(assetPath);
                const loadStarted = performance.now();
                console.info("[VNCCS 3D Factory][viewport] Fetching SPLAT", {
                    build: FACTORY_VIEWER_BUILD,
                    objectId: item.object_id,
                    url: assetURL,
                });
                const response = await fetch(assetURL, {
                    signal: loadController.signal,
                    credentials: "same-origin",
                    cache: "default",
                });
                if (!response.ok) {
                    let detail = "";
                    try { detail = (await response.text()).slice(0, 500); }
                    catch (_) {}
                    throw new Error(
                        `SPLAT download failed for ${item.object_id}: HTTP ${response.status}`
                        + (detail ? ` — ${detail}` : ""),
                    );
                }
                const preparedAsset = await prepareSplatBufferAsync(
                    await response.arrayBuffer(),
                    `SPLAT object ${item.object_id}`,
                    { signal: loadController.signal },
                );
                const fileBytes = preparedAsset.buffer;
                const gaussianCount = fileBytes.byteLength / 32;
                const createMesh = () => {
                    const value = new SplatMesh({
                        fileBytes,
                        fileType: "splat",
                        fileName: `${item.object_id}.splat`,
                        // Runtime LoD generation is intentionally disabled.
                        // Spark's Bhatt builder can take tens of seconds per
                        // 524k object and expands it to roughly twice as many
                        // records before anything becomes visible. The source
                        // SPLAT is already compact and decodes directly.
                        lod: false,
                        editable: false,
                        raycastable: false,
                    });
                    value.name = item.name || item.object_id;
                    value.userData.factoryObjectId = item.object_id;
                    value.setRotationFromMatrix(triposplatCanonicalMatrix());
                    value.updateMatrix();
                    return value;
                };
                // Decode exactly once and make the source SPLAT visible as soon
                // as Spark has uploaded it. Do not queue any derived mesh.
                mesh = createMesh();
                objectRoot = new THREE.Group();
                objectRoot.name = item.name || item.object_id;
                objectRoot.userData.factoryObjectId = item.object_id;
                objectRoot.add(mesh);
                this.scene.add(objectRoot);
                await mesh.initialized;
                if (!Number.isFinite(mesh.numSplats) || mesh.numSplats < 1) {
                    throw new Error(`SPLAT object ${item.object_id} decoded to zero Gaussians`);
                }
                if (token !== this._loadingToken || this._disposed) {
                    this.scene.remove(objectRoot);
                    mesh.dispose?.();
                    return;
                }
                this._applyTransform(objectRoot, item.transform);
                objectRoot.visible = visibleIds.has(item.object_id);
                const splatBounds = hasFiniteBounds(preparedAsset.bounds)
                    ? preparedAsset.bounds
                    : computeRobustSplatBounds(mesh);
                const localBounds = splatBounds.clone().applyMatrix4(mesh.matrix);
                if (!hasFiniteBounds(localBounds)) {
                    throw new Error(
                        `SPLAT object ${item.object_id} has no finite interaction bounds after decoding`,
                    );
                }
                const entry = {
                    mesh: objectRoot,
                    splat: mesh,
                    data: item,
                    localBounds,
                    splatBounds,
                    assetPath,
                };
                this.objects.set(item.object_id, entry);
                this._attachShadowProxy(entry);
                this._attachDirectionalLighting(entry);
                this.spark.setDirty?.();
                this.resize();
                this.invalidate();
                console.info("[VNCCS 3D Factory][viewport] SPLAT ready", {
                    build: FACTORY_VIEWER_BUILD,
                    objectId: item.object_id,
                    bytes: fileBytes.byteLength,
                    gaussians: gaussianCount,
                    payload: preparedAsset.diagnostics,
                    lod: {
                        enabled: false,
                        builder: "none",
                        singlePass: true,
                        meshRebuild: false,
                    },
                    interactionBounds: {
                        min: localBounds.min.toArray(),
                        max: localBounds.max.toArray(),
                    },
                    elapsedMs: Math.round(performance.now() - loadStarted),
                });
            } catch (error) {
                if (error?.name === "AbortError") return;
                if (objectRoot) this.scene.remove(objectRoot);
                mesh?.dispose?.();
                failures.push({ objectId: item.object_id, error });
                this.options.onError(error);
            }
        }
        await skydomePromise;
        if (token === this._loadingToken) {
            if (needsAssetLoading) this.options.onLoadingChange(false);
            if (this._loadController === loadController) this._loadController = null;
        }
        if (this.selectedGroupId && this.selectedGroupObjectIds.some(id => this.objects.has(id))) {
            this.selectGroup(this.selectedGroupId, this.selectedGroupObjectIds);
        } else if (this.selectedId && this.objects.has(this.selectedId)) this.select(this.selectedId);
        else if (!incremental) {
            const firstVisible = source.find(item => visibleIds.has(item.object_id));
            if (firstVisible && this.objects.has(firstVisible.object_id)) this.select(firstVisible.object_id);
            else this.select("");
        } else {
            // Incremental geometry/history refreshes must not manufacture a
            // Gaussian selection and replace an open architecture Inspector.
            this.select("");
        }
        if (this.objects.size && (!incremental || previousCount === 0)) this.fit();
        this.resize();
        this.invalidate();
        return { loaded: this.objects.size, failures };
    }

    updateObject(objectId, value) {
        const entry = this.objects.get(objectId);
        if (!entry) return;
        entry.data = { ...entry.data, ...value };
        if ("name" in value) {
            entry.mesh.name = value.name || objectId;
            entry.splat.name = value.name || objectId;
        }
        if ("visible" in value || "level_id" in value || "building_id" in value) {
            const visibleIds = effectiveVisibleObjectIds(this.sceneData || {});
            entry.mesh.visible = visibleIds.has(objectId)
                && (this.viewMode !== "plan" || !entry.data.level_id || entry.data.level_id === this.activeLevelId);
        }
        this._syncShadowProxy(entry);
        if (value.transform) {
            this._applyTransform(entry.mesh, value.transform);
            for (const candidate of this.objects.values()) {
                this._syncDirectionalLighting(candidate);
            }
        }
        if ("locked" in value && objectId === this.selectedId) {
            this.transform.enabled = this.viewMode === "3d" && value.locked !== true;
        }
        if (objectId === this.selectedId || this.selectedGroupObjectIds.includes(objectId)) {
            this._refreshSelectionBounds();
        }
        this.spark.setDirty?.();
        if (this.host?.getBoundingClientRect) this.resize();
        this.invalidate();
    }

    applySceneVisibility(sceneData = this.sceneData) {
        this.sceneData = sceneData || this.sceneData;
        const visibleIds = effectiveVisibleObjectIds(this.sceneData || {});
        for (const [objectId, entry] of this.objects) {
            entry.mesh.visible = visibleIds.has(objectId)
                && (this.viewMode !== "plan" || !entry.data.level_id || entry.data.level_id === this.activeLevelId);
        }
        this._refreshSelectionBounds();
        this.spark.setDirty?.();
        if (this.host?.getBoundingClientRect) this.resize();
        this.invalidate();
    }

    setGroupVisibility(
        groupId,
        objectIds = [],
        visible = true,
        sceneData = this.sceneData,
    ) {
        this.sceneData = sceneData || this.sceneData;
        const group = (Array.isArray(this.sceneData?.layers) ? this.sceneData.layers : [])
            .find(layer => layer?.type === "group" && layer.group_id === groupId);
        const children = Array.from(new Set(
            Array.isArray(group?.children) ? group.children : objectIds,
        ));
        const showGroup = Boolean(visible);
        if (group) group.visible = showGroup;
        const visibleIds = effectiveVisibleObjectIds(this.sceneData || {});
        let hasVisibleChild = false;
        for (const objectId of children) {
            const entry = this.objects.get(objectId);
            if (!entry) continue;
            const childVisible = visibleIds.has(objectId)
                && (this.viewMode !== "plan" || !entry.data.level_id || entry.data.level_id === this.activeLevelId);
            entry.mesh.visible = childVisible;
            hasVisibleChild ||= childVisible;
        }
        if (this.selectedGroupId === groupId) {
            if (hasVisibleChild) {
                this._configureGroupPivot();
            } else {
                this.transform.detach();
                this.selectionBounds.visible = false;
                this.selectionBounds.box.makeEmpty();
            }
        }
        this.spark.setDirty?.();
        if (this.host?.getBoundingClientRect) this.resize();
        this.invalidate();
    }

    select(objectId, { additive = false } = {}) {
        const id = this.objects.has(objectId) ? objectId : "";
        this.selectedId = id;
        this.selectedGroupId = "";
        this.selectedGroupObjectIds = [];
        this._groupTransformStart = null;
        if (id) this.transform.attach(this.objects.get(id).mesh);
        else this.transform.detach();
        this.transform.enabled = this.viewMode === "3d"
            && Boolean(id)
            && this.objects.get(id)?.data?.locked !== true;
        this._refreshSelectionBounds();
        this.options.onSelectionChange(id, { additive });
        this._emitState();
        this.invalidate();
    }

    selectGroup(groupId, objectIds = []) {
        const ids = Array.from(new Set(objectIds)).filter(objectId => this.objects.has(objectId));
        this.selectedId = "";
        this.selectedGroupId = ids.length ? String(groupId || "") : "";
        this.selectedGroupObjectIds = ids;
        this._groupTransformStart = null;
        if (this.selectedGroupId) this._configureGroupPivot();
        else this.transform.detach();
        this._refreshSelectionBounds();
        this._emitState();
        this.invalidate();
    }

    getGroupPivotPosition() {
        if (!this.selectedGroupId) return [0, 0, 0];
        this._configureGroupPivot();
        return this.groupPivot.position.toArray();
    }

    applyGroupDelta({ position, rotation, scale } = {}) {
        if (!this.selectedGroupId) return false;
        this._configureGroupPivot();
        this._beginGroupTransform();
        if (!this._groupTransformStart) return false;
        if (Array.isArray(position) && position.length === 3) {
            this.groupPivot.position.fromArray(position.map(Number));
        }
        const angles = Array.isArray(rotation) ? rotation.map(Number) : [0, 0, 0];
        this.groupPivot.rotation.set(
            radians(angles[0] || 0),
            radians(angles[1] || 0),
            radians(angles[2] || 0),
            "XYZ",
        );
        this.groupPivot.scale.setScalar(Math.max(0.001, Math.min(1000, Number(scale) || 1)));
        this.groupPivot.updateMatrixWorld(true);
        this._applyGroupTransform(true);
        this._configureGroupPivot();
        return true;
    }

    setMode(mode) {
        if (!["translate", "rotate", "scale"].includes(mode)) return;
        this.mode = mode;
        this.transform.setMode(mode);
        this.transform.showX = true;
        this.transform.showY = true;
        this.transform.showZ = true;
        this._emitState();
        this.invalidate();
    }

    setGrid(visible) {
        this.gridVisible = Boolean(visible);
        this.grid.visible = this.gridVisible && this.viewMode === "3d";
        this._emitState();
        this.invalidate();
    }

    setPlanGrid(value = {}) {
        const next = {
            visible: value.visible !== false,
            step: Math.max(0.001, Math.min(1000, Number(value.step) || 0.1)),
            majorEvery: Math.max(2, Math.min(100, Math.round(Number(value.majorEvery) || 10))),
        };
        const previous = this.planGridState || {};
        const changed = previous.visible !== next.visible
            || previous.step !== next.step
            || previous.majorEvery !== next.majorEvery;
        this.planGridState = next;
        if (!changed) return;
        this._planGridSignature = "";
        this._syncPlanGrid();
        this.invalidate();
    }

    setViewMode(mode) {
        const next = mode === "plan" ? "plan" : "3d";
        if (next === this.viewMode) return;
        this.viewMode = next;
        this.controls.enabled = next === "3d" && !this.transform.dragging;
        this.transform.camera = this.activeCamera();
        const selectionEditable = this.selectedGroupId
            ? this._groupEntries().length > 0
            : Boolean(this.selectedId) && this.objects.get(this.selectedId)?.data?.locked !== true;
        this.transform.enabled = next === "3d" && selectionEditable;
        this.transformHelper.visible = next === "3d" && Boolean(this.selectedId || this.selectedGroupId);
        this.cameraFrame.style.display = next === "3d" && this.cameraFrameVisible ? "block" : "none";
        this.grid.visible = next === "3d" && this.gridVisible;
        this.architecture.setActiveLevel(this.activeLevelId, next === "plan");
        this.applySceneVisibility(this.sceneData);
        this._syncThreeLights();
        this.planOverlay.visible = next === "plan";
        this.canvas.style.cursor = next === "plan" && this.planTool !== "select"
            ? "crosshair"
            : "default";
        if (next === "plan") this._syncPlanGrid();
        this.resize();
        this.spark.setDirty?.();
        this._emitState();
        this.invalidate();
    }

    setPlanTool(tool) {
        if (!["select", "wall", "room", "opening", "camera"].includes(tool)) return;
        this.planTool = tool;
        this.canvas.style.cursor = this.viewMode === "plan" && tool !== "select" ? "crosshair" : "default";
        this._emitState();
    }

    _clearPlanRoot(root) {
        for (const child of [...root.children]) {
            child.traverse(object => {
                object.geometry?.dispose?.();
                if (Array.isArray(object.material)) object.material.forEach(material => material.dispose?.());
                else object.material?.dispose?.();
            });
            root.remove(child);
        }
    }

    _planHandleHit(event) {
        const rect = this.canvas.getBoundingClientRect();
        this.pointer.set(
            ((event.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1,
            -((event.clientY - rect.top) / Math.max(1, rect.height)) * 2 + 1,
        );
        this.raycaster.setFromCamera(this.pointer, this.planCamera);
        return this.raycaster.intersectObject(this.architectureHandleRoot, true)
            .find(hit => hit.object?.userData?.factoryHandleType)?.object || null;
    }

    setArchitectureSelection(selection) {
        this.architectureSelection = selection?.id
            ? { type: String(selection.type || ""), id: String(selection.id) }
            : null;
        this._clearPlanRoot(this.architectureHandleRoot);
        if (!selection?.id) {
            this.invalidate();
            return;
        }
        const architecture = this.sceneData?.architecture || {};
        const addHandle = ({ type, id, point, elevation, endpoint = "", color = "#ff8fa3" }) => {
            const radius = Math.max(0.055, 8 / Math.max(1, Number(this.planCameraState.zoom) || 24));
            const handle = new THREE.Mesh(
                new THREE.CircleGeometry(radius, 20),
                new THREE.MeshBasicMaterial({ color, depthTest: false, side: THREE.DoubleSide }),
            );
            handle.rotation.x = -Math.PI / 2;
            handle.position.set(point[0], elevation, point[1]);
            handle.renderOrder = 60;
            handle.userData = {
                factoryHandleType: type,
                factoryHandleId: id,
                endpoint,
            };
            this.architectureHandleRoot.add(handle);
        };
        if (selection.type === "building") {
            const building = architecture.buildings?.find(item => item.building_id === selection.id);
            if (!building || building.locked) return this.invalidate();
            const level = this.sceneData?.levels?.find(item => item.level_id === this.activeLevelId);
            addHandle({
                type: "building",
                id: building.building_id,
                point: [Number(building.position?.[0]) || 0, Number(building.position?.[2]) || 0],
                elevation: (Number(level?.elevation) || 0)
                    + (Number(building.position?.[1]) || 0)
                    + 0.07,
                color: "#b8a9e8",
            });
            return this.invalidate();
        }
        if (selection.type === "opening") {
            const opening = architecture.openings?.find(item => item.opening_id === selection.id);
            const wall = architecture.walls?.find(item => item.wall_id === opening?.wall_id);
            const owner = architecture.buildings?.find(item => item.building_id === wall?.building_id);
            if (!opening || !wall || opening.locked || wall.locked || owner?.locked) return this.invalidate();
            const level = this.sceneData?.levels?.find(item => item.level_id === wall.level_id);
            const offset = Math.max(0, Math.min(1, Number(opening.offset) || 0));
            const position = new THREE.Vector3(
                wall.start[0] + (wall.end[0] - wall.start[0]) * offset,
                (Number(level?.elevation) || 0) + 0.075,
                wall.start[1] + (wall.end[1] - wall.start[1]) * offset,
            );
            this.architecture.buildingRoots.get(wall.building_id)?.localToWorld(position);
            addHandle({ type: "opening", id: opening.opening_id, point: [position.x, position.z], elevation: position.y, color: "#69d5e7" });
            return this.invalidate();
        }
        if (selection.type === "room" || selection.type === "floor" || selection.type === "ceiling") {
            const room = architecture.rooms?.find(item => item.room_id === selection.id);
            const linkedWalls = new Set(room?.wall_ids || []);
            const owner = architecture.buildings?.find(item => item.building_id === room?.building_id);
            if (
                !room?.polygon?.length
                || room.locked
                || owner?.locked
                || architecture.walls?.some(wall => linkedWalls.has(wall.wall_id) && wall.locked)
            ) return this.invalidate();
            const level = this.sceneData?.levels?.find(item => item.level_id === room.level_id);
            const center = room.polygon.reduce((sum, point) => [sum[0] + point[0], sum[1] + point[1]], [0, 0]).map(value => value / room.polygon.length);
            const position = new THREE.Vector3(center[0], (Number(level?.elevation) || 0) + 0.065, center[1]);
            this.architecture.buildingRoots.get(room.building_id)?.localToWorld(position);
            addHandle({ type: "room", id: room.room_id, point: [position.x, position.z], elevation: position.y, color: "#b8a9e8" });
            return this.invalidate();
        }
        if (selection.type !== "wall") {
            this.invalidate();
            return;
        }
        const wall = architecture.walls?.find(item => item.wall_id === selection.id);
        const owner = architecture.buildings?.find(item => item.building_id === wall?.building_id);
        if (!wall || wall.locked || owner?.locked) return this.invalidate();
        const level = this.sceneData?.levels?.find(item => item.level_id === wall.level_id);
        const elevation = (Number(level?.elevation) || 0) + 0.055;
        const building = this.architecture.buildingRoots.get(wall.building_id);
        for (const endpoint of ["start", "end"]) {
            const position = new THREE.Vector3(wall[endpoint][0], elevation, wall[endpoint][1]);
            if (building) building.localToWorld(position);
            addHandle({ type: "wall", id: wall.wall_id, point: [position.x, position.z], elevation: position.y, endpoint });
        }
        this.invalidate();
    }

    setPlanDraft(draft) {
        this._clearPlanRoot(this.planDraftRoot);
        const points = Array.isArray(draft?.points) ? draft.points : [];
        const cursor = Array.isArray(draft?.cursor) ? draft.cursor : null;
        const opening = draft?.opening && typeof draft.opening === "object"
            ? draft.opening
            : null;
        if (!points.length && !cursor && !opening) {
            this.invalidate();
            return;
        }
        const level = this.sceneData?.levels?.find(item => item.level_id === this.activeLevelId);
        const elevation = (Number(level?.elevation) || 0) + 0.035;
        const addLine = (source, color = "#ff8fa3", opacity = 1, order = 50) => {
            if (!Array.isArray(source) || source.length < 2) return;
            const vertices = source.map(point => new THREE.Vector3(point[0], elevation + 0.006, point[1]));
            const geometry = new THREE.BufferGeometry().setFromPoints(vertices);
            const line = new THREE.Line(
                geometry,
                new THREE.LineBasicMaterial({
                    color,
                    transparent: opacity < 1,
                    opacity,
                    depthTest: false,
                    depthWrite: false,
                }),
            );
            line.renderOrder = order;
            this.planDraftRoot.add(line);
        };
        const addMarker = (point, color = "#ffc1cf", radius = 0.065, order = 53) => {
            if (!Array.isArray(point)) return;
            const marker = new THREE.Mesh(
                new THREE.CircleGeometry(radius, 20),
                new THREE.MeshBasicMaterial({
                    color,
                    depthTest: false,
                    depthWrite: false,
                    side: THREE.DoubleSide,
                }),
            );
            marker.rotation.x = -Math.PI / 2;
            marker.position.set(point[0], elevation + 0.01, point[1]);
            marker.renderOrder = order;
            this.planDraftRoot.add(marker);
        };
        const addStrip = (start, end, width, color, opacity = 0.35, order = 48) => {
            if (!Array.isArray(start) || !Array.isArray(end)) return;
            const dx = end[0] - start[0];
            const dz = end[1] - start[1];
            const length = Math.hypot(dx, dz);
            if (length < 0.001) return;
            const strip = new THREE.Mesh(
                new THREE.BoxGeometry(length, 0.012, Math.max(0.01, Number(width) || 0.12)),
                new THREE.MeshBasicMaterial({
                    color,
                    transparent: true,
                    opacity,
                    depthTest: false,
                    depthWrite: false,
                }),
            );
            strip.position.set((start[0] + end[0]) / 2, elevation, (start[1] + end[1]) / 2);
            strip.rotation.y = -Math.atan2(dz, dx);
            strip.renderOrder = order;
            this.planDraftRoot.add(strip);
        };

        if (draft?.tool === "wall") {
            addLine(points, "#ff8fa3", 0.58, 49);
            for (const point of points) addMarker(point, "#ffb6c8", 0.052, 52);
            const start = points.at(-1);
            if (start && cursor && Math.hypot(cursor[0] - start[0], cursor[1] - start[1]) >= 0.001) {
                addStrip(start, cursor, draft.thickness || 0.12, "#ff8fa3", 0.32, 50);
                addLine([start, cursor], "#ffd5de", 1, 51);
            }
            if (cursor) addMarker(cursor, "#fff1f4", 0.075, 54);
            this.invalidate();
            return;
        }

        if (draft?.tool === "room") {
            const rectangle = Array.isArray(draft.rectangle) ? draft.rectangle : [];
            if (rectangle.length === 4) {
                const shape = new THREE.Shape();
                rectangle.forEach((point, index) => {
                    if (index === 0) shape.moveTo(point[0], point[1]);
                    else shape.lineTo(point[0], point[1]);
                });
                shape.closePath();
                const fill = new THREE.Mesh(
                    new THREE.ShapeGeometry(shape),
                    new THREE.MeshBasicMaterial({
                        color: "#b8a9e8",
                        transparent: true,
                        opacity: 0.18,
                        depthTest: false,
                        depthWrite: false,
                        side: THREE.DoubleSide,
                    }),
                );
                fill.geometry.rotateX(Math.PI / 2);
                fill.position.y = elevation;
                fill.renderOrder = 47;
                this.planDraftRoot.add(fill);
                for (let index = 0; index < rectangle.length; index += 1) {
                    addStrip(
                        rectangle[index],
                        rectangle[(index + 1) % rectangle.length],
                        draft.thickness || 0.12,
                        "#b8a9e8",
                        0.28,
                        49,
                    );
                }
                addLine([...rectangle, rectangle[0]], "#d7ccff", 1, 51);
                for (const point of rectangle) addMarker(point, "#d7ccff", 0.052, 52);
            } else {
                for (const point of points) addMarker(point, "#d7ccff", 0.065, 52);
            }
            if (cursor) addMarker(cursor, "#f0ebff", 0.075, 54);
            this.invalidate();
            return;
        }

        if (draft?.tool === "camera") {
            const position = points[0];
            if (position) addMarker(position, "#d7ccff", 0.085, 55);
            if (position && cursor) {
                const dx = cursor[0] - position[0];
                const dz = cursor[1] - position[1];
                const distance = Math.hypot(dx, dz);
                if (distance >= 0.001) {
                    const length = Math.min(Math.max(0.5, distance), 2.5);
                    const angle = Math.atan2(dx, -dz);
                    const halfFov = THREE.MathUtils.degToRad(
                        Math.max(5, Math.min(120, Number(draft.fov) || 42)) / 2,
                    );
                    const endpoint = bearing => [
                        position[0] + Math.sin(bearing) * length,
                        position[1] - Math.cos(bearing) * length,
                    ];
                    const left = endpoint(angle - halfFov);
                    const right = endpoint(angle + halfFov);
                    addLine([position, cursor], "#fff1f4", 1, 52);
                    addLine([left, position, right], "#b8a9e8", 0.9, 51);
                    addMarker(cursor, "#fff1f4", 0.065, 54);
                }
            } else if (cursor) {
                addMarker(cursor, "#d7ccff", 0.085, 55);
            }
            this.invalidate();
            return;
        }

        if (draft?.tool === "opening") {
            if (opening?.start && opening?.end) {
                const fillColor = opening.kind === "door" ? "#ffca85" : "#69d8ff";
                const lineColor = opening.kind === "door" ? "#ffe2b5" : "#d8f5ff";
                addStrip(
                    opening.start,
                    opening.end,
                    Math.max(0.18, Number(opening.thickness) * 1.8 || 0.18),
                    fillColor,
                    0.62,
                    51,
                );
                addLine([opening.start, opening.end], lineColor, 1, 52);
                addMarker(opening.center, lineColor, 0.07, 54);
            } else if (cursor) {
                addMarker(cursor, "#ff5b6b", 0.075, 54);
            }
            this.invalidate();
            return;
        }

        if (points.length > 1) addLine(points);
        for (const point of points) addMarker(point);
        if (cursor) addMarker(cursor, "#fff1f4", 0.075, 54);
        this.invalidate();
    }

    setCameraMarkers(cameras = []) {
        this._clearPlanRoot(this.cameraMarkerRoot);
        const level = this.sceneData?.levels?.find(item => item.level_id === this.activeLevelId);
        const elevation = (Number(level?.elevation) || 0) + 0.045;
        const markerRadius = Math.max(0.08, 9 / Math.max(1, Number(this.planCameraState.zoom) || 24));
        for (const camera of cameras) {
            if (camera.level_id && camera.level_id !== this.activeLevelId) continue;
            const owner = this.sceneData?.architecture?.buildings?.find(
                building => building.building_id === camera.building_id,
            );
            if (owner?.visible === false) continue;
            const position = new THREE.Vector3().fromArray(camera.position || [0, 1.6, 0]);
            const target = new THREE.Vector3().fromArray(camera.target || [0, 1.6, -1]);
            const direction = target.sub(position);
            const angle = Math.atan2(direction.x, -direction.z);
            const group = new THREE.Group();
            group.position.set(position.x, elevation, position.z);
            group.userData = { factoryType: "camera", factoryId: camera.camera_id };
            const marker = new THREE.Mesh(
                new THREE.CircleGeometry(markerRadius, 24),
                new THREE.MeshBasicMaterial({ color: "#b8a9e8", depthTest: false, side: THREE.DoubleSide }),
            );
            marker.rotation.x = -Math.PI / 2;
            marker.userData = group.userData;
            marker.renderOrder = 45;
            const arrowGeometry = new THREE.BufferGeometry().setFromPoints([
                new THREE.Vector3(0, 0.01, 0),
                new THREE.Vector3(Math.sin(angle) * 0.55, 0.01, -Math.cos(angle) * 0.55),
            ]);
            const arrow = new THREE.Line(
                arrowGeometry,
                new THREE.LineBasicMaterial({ color: "#d7ccff", depthTest: false }),
            );
            arrow.userData = marker.userData;
            const halfFov = THREE.MathUtils.degToRad(Math.max(5, Math.min(120, Number(camera.fov) || 42)) / 2);
            const frustumLength = 0.9;
            const leftAngle = angle - halfFov;
            const rightAngle = angle + halfFov;
            const frustumGeometry = new THREE.BufferGeometry().setFromPoints([
                new THREE.Vector3(Math.sin(leftAngle) * frustumLength, 0.01, -Math.cos(leftAngle) * frustumLength),
                new THREE.Vector3(0, 0.01, 0),
                new THREE.Vector3(Math.sin(rightAngle) * frustumLength, 0.01, -Math.cos(rightAngle) * frustumLength),
            ]);
            const frustum = new THREE.Line(
                frustumGeometry,
                new THREE.LineBasicMaterial({ color: "#9f8cde", transparent: true, opacity: 0.8, depthTest: false }),
            );
            frustum.userData = marker.userData;
            frustum.renderOrder = 44;
            group.add(marker, arrow, frustum);
            this.cameraMarkerRoot.add(group);
        }
        this.invalidate();
    }

    setLightMarkers(lights = []) {
        if (!this.lightMarkerRoot) return;
        this._clearPlanRoot(this.lightMarkerRoot);
        const level = this.sceneData?.levels?.find(item => item.level_id === this.activeLevelId);
        const elevation = (Number(level?.elevation) || 0) + 0.05;
        const radius = Math.max(0.07, 8 / Math.max(1, Number(this.planCameraState.zoom) || 24));
        for (const light of lights) {
            if (light.visible === false || (light.level_id && light.level_id !== this.activeLevelId)) continue;
            const owner = this.sceneData?.architecture?.buildings?.find(
                building => building.building_id === light.building_id,
            );
            if (owner?.visible === false) continue;
            const [x, , z] = light.position || [0, 0, 0];
            const marker = new THREE.Mesh(
                new THREE.CircleGeometry(radius, 20),
                new THREE.MeshBasicMaterial({
                    color: light.color || "#ffffff",
                    depthTest: false,
                    side: THREE.DoubleSide,
                }),
            );
            marker.rotation.x = -Math.PI / 2;
            marker.position.set(Number(x) || 0, elevation, Number(z) || 0);
            marker.renderOrder = 43;
            marker.raycast = EMPTY;
            this.lightMarkerRoot.add(marker);
        }
        this.invalidate();
    }

    setActiveLevel(levelId) {
        if (!this.sceneData?.levels?.some(item => item.level_id === levelId)) return;
        this.activeLevelId = levelId;
        this.architecture.setActiveLevel(levelId, this.viewMode === "plan");
        this.applySceneVisibility(this.sceneData);
        const level = this.sceneData.levels.find(item => item.level_id === levelId);
        this.grid.position.y = Number(level?.elevation) || 0;
        this._planGridSignature = "";
        this.setCameraMarkers(this.sceneData.cameras || []);
        this.setLightMarkers(this.lighting.lights || []);
        this._syncThreeLights();
        for (const entry of this.objects.values()) this._syncDirectionalLighting(entry);
        this._syncPlanCamera();
        this._emitState();
        this.invalidate();
    }

    updateArchitectureItem(type, id, sceneData = this.sceneData) {
        this.sceneData = sceneData || this.sceneData;
        const updated = this.architecture.updateItem(type, id, this.sceneData);
        if (!updated) return false;
        this.architecture.setActiveLevel(this.activeLevelId, this.viewMode === "plan");
        this.setArchitectureSelection(this.architectureSelection);
        this.invalidate();
        return true;
    }

    async refreshArchitecture(sceneData = this.sceneData) {
        this.sceneData = sceneData || this.sceneData;
        await this.architecture.set(this.sceneData);
        this.architecture.setActiveLevel(this.activeLevelId, this.viewMode === "plan");
        this.setArchitectureSelection(this.architectureSelection);
        this.setCameraMarkers(this.sceneData?.cameras || []);
        this.invalidate();
    }

    worldToBuildingPlan(point, buildingId = "") {
        const source = new THREE.Vector3(Number(point?.[0]) || 0, 0, Number(point?.[1]) || 0);
        const building = this.architecture.buildingRoots.get(buildingId)
            || this.architecture.buildingRoots.values().next().value;
        if (building) building.worldToLocal(source);
        return [Number(source.x.toFixed(6)), Number(source.z.toFixed(6))];
    }

    dropSelectionToSurface({ individual = false } = {}) {
        const selectedIds = this.selectedGroupId
            ? [...this.selectedGroupObjectIds]
            : this.selectedId
                ? [this.selectedId]
                : [];
        if (!selectedIds.length) return null;
        const groups = individual ? selectedIds.map(id => [id]) : [selectedIds];
        const results = [];
        for (const group of groups) {
            const movableGroup = group.filter(objectId => !this.objects.get(objectId)?.data?.locked);
            if (!movableGroup.length) continue;
            const selectedLevelIds = new Set(movableGroup
                .map(objectId => this.objects.get(objectId)?.data?.level_id)
                .filter(Boolean));
            const selectedBuildingIds = new Set(movableGroup
                .map(objectId => this.objects.get(objectId)?.data?.building_id)
                .filter(Boolean));
            const targetLevelId = selectedLevelIds.size === 1
                ? selectedLevelIds.values().next().value
                : this.activeLevelId;
            const level = this.sceneData?.levels?.find(item => item.level_id === targetLevelId);
            const targetBuildingId = selectedBuildingIds.size === 1
                ? selectedBuildingIds.values().next().value
                : "";
            const building = this.sceneData?.architecture?.buildings?.find(
                item => item.building_id === targetBuildingId,
            );
            const floorElevations = [
                (Number(level?.elevation) || 0) + (Number(building?.position?.[1]) || 0),
            ];
            const eligibleEntries = new Map(Array.from(this.objects.entries()).filter(
                ([objectId, entry]) => movableGroup.includes(objectId)
                    || !entry.data?.level_id
                    || (
                        entry.data.level_id === targetLevelId
                        && (!targetBuildingId || !entry.data.building_id || entry.data.building_id === targetBuildingId)
                    ),
            ));
            const previousTransforms = Object.fromEntries(movableGroup.map(objectId => {
                const entry = this.objects.get(objectId);
                return [objectId, entry ? this._meshTransform(entry.mesh) : null];
            }));
            const result = solveDropToSurface({
                entries: eligibleEntries,
                selectedIds: movableGroup,
                floorElevations,
            });
            if (!result) continue;
            for (const [groupIndex, objectId] of movableGroup.entries()) {
                const entry = this.objects.get(objectId);
                if (!entry) continue;
                entry.mesh.position.y += result.deltaY;
                entry.mesh.updateMatrixWorld(true);
                const transform = this._meshTransform(entry.mesh);
                entry.data.transform = transform;
                this.options.onTransformChange(objectId, transform, {
                    final: true,
                    source: "drop",
                    previous_transforms: previousTransforms,
                    command_last: groupIndex === movableGroup.length - 1,
                });
            }
            results.push(result);
        }
        this._refreshSelectionBounds();
        this.spark.setDirty?.();
        this._emitState();
        this.invalidate();
        return results;
    }

    setCaptureSettings(value = {}) {
        const width = Math.round(Number(value.width));
        const height = Math.round(Number(value.height));
        if (Number.isFinite(width)) this.captureWidth = Math.max(64, Math.min(4096, width));
        if (Number.isFinite(height)) this.captureHeight = Math.max(64, Math.min(4096, height));
        if ("show_camera_frame" in value) {
            this.cameraFrameVisible = Boolean(value.show_camera_frame);
        }
        this._updateCameraProjection();
        this._updateCameraFrame();
        this.spark.setDirty?.();
        this.invalidate();
    }

    getCaptureSettings() {
        return {
            width: this.captureWidth,
            height: this.captureHeight,
            show_camera_frame: this.cameraFrameVisible,
        };
    }

    _expandVisibleObjectBounds(box, root) {
        if (!root?.visible) return box;
        root.updateMatrixWorld?.(true);
        root.traverseVisible?.(child => {
            const geometry = child.geometry;
            if (!geometry || child.userData?.factoryPlanOnly) return;
            if (!geometry.boundingBox) geometry.computeBoundingBox?.();
            if (!geometry.boundingBox?.isEmpty?.()) {
                box.union(geometry.boundingBox.clone().applyMatrix4(child.matrixWorld));
            }
        });
        return box;
    }

    _viewBounds({ scope = "scene", objectId = "" } = {}) {
        const box = new THREE.Box3();
        let entries = [];
        if (objectId && this.objects.has(objectId)) {
            entries = [this.objects.get(objectId)];
        } else if (scope === "selection" && this.selectedGroupId) {
            entries = this._groupEntries().map(([, entry]) => entry);
        } else if (scope === "selection" && this.selectedId && this.objects.has(this.selectedId)) {
            entries = [this.objects.get(this.selectedId)];
        } else if (scope === "scene") {
            entries = Array.from(this.objects.values()).filter(entry => entry.mesh.visible !== false);
        }
        for (const entry of entries) {
            try {
                entry.mesh.updateMatrixWorld(true);
                box.union(entry.localBounds.clone().applyMatrix4(entry.mesh.matrixWorld));
            } catch (_) {}
        }

        if (scope === "scene") {
            this._expandVisibleObjectBounds(box, this.architecture?.root);
        } else if (scope === "selection" && box.isEmpty() && this.architectureSelection?.id) {
            const selection = this.architectureSelection;
            const itemType = selection.type === "floor" || selection.type === "ceiling"
                ? "room"
                : selection.type;
            let architectureObject = this.architecture?.items?.get(`${itemType}:${selection.id}`);
            if (selection.type === "opening") {
                const opening = this.sceneData?.architecture?.openings?.find(
                    item => item.opening_id === selection.id,
                );
                architectureObject = opening
                    ? this.architecture?.items?.get(`wall:${opening.wall_id}`)
                    : null;
            }
            if (selection.type === "level") {
                for (const [key, object] of this.architecture?.items || []) {
                    if (key.startsWith("building:")) continue;
                    const [type, id] = key.split(":");
                    const source = type === "wall"
                        ? this.sceneData?.architecture?.walls?.find(item => item.wall_id === id)
                        : this.sceneData?.architecture?.rooms?.find(item => item.room_id === id);
                    if (source?.level_id === selection.id) this._expandVisibleObjectBounds(box, object);
                }
            } else if (architectureObject) {
                this._expandVisibleObjectBounds(box, architectureObject);
            }
        }
        return box;
    }

    _frameBounds(box, { direction = null, emit = true } = {}) {
        if (!box || box.isEmpty()) return false;
        const sphere = box.getBoundingSphere(new THREE.Sphere());
        const radius = Math.max(sphere.radius, 0.001);
        // Fit against the export camera, not the editor canvas. Portrait
        // frames can be much narrower than the viewport, while a wide frame
        // can temporarily expand the editor FOV to show the complete crop.
        const verticalHalfFov = THREE.MathUtils.degToRad(this.captureFov * 0.5);
        const captureAspect = this.captureWidth / Math.max(1, this.captureHeight);
        const horizontalHalfFov = Math.atan(Math.tan(verticalHalfFov) * captureAspect);
        const limitingHalfFov = Math.max(
            THREE.MathUtils.degToRad(2.5),
            Math.min(verticalHalfFov, horizontalHalfFov),
        );
        const distance = radius / Math.sin(limitingHalfFov) * 1.16;
        const viewDirection = direction
            ? new THREE.Vector3().fromArray(direction)
            : this.camera.position.clone().sub(this.controls.target);
        if (viewDirection.lengthSq() < 1e-12) viewDirection.set(0.7, 0.5, 1);
        viewDirection.normalize();
        this.controls.target.copy(sphere.center);
        this.camera.position.copy(sphere.center).addScaledVector(viewDirection, distance);
        this.controls.minDistance = radius * 0.001;
        this.controls.maxDistance = radius * 10000;
        this.camera.lookAt(this.controls.target);
        this.controls.update();
        this._updateClipPlanes(radius);
        this.invalidate();
        if (emit) {
            this._cameraStateDirty = false;
            this._emitState();
        }
        return true;
    }

    fit(objectId = "", { emit = true } = {}) {
        return this._frameBounds(
            this._viewBounds({ scope: objectId ? "selection" : "scene", objectId }),
            { emit },
        );
    }

    frameScene({ emit = true } = {}) {
        return this._frameBounds(this._viewBounds({ scope: "scene" }), { emit });
    }

    frameSelection({ emit = true } = {}) {
        return this._frameBounds(this._viewBounds({ scope: "selection" }), { emit });
    }

    resetView({ emit = true } = {}) {
        this.camera.up.set(0, 1, 0);
        const framed = this._frameBounds(
            this._viewBounds({ scope: "scene" }),
            { direction: [0.62, 0.46, 0.78], emit },
        );
        if (framed) return true;
        this.camera.position.set(2.8, 2.1, 4.2);
        this.controls.target.set(0, 0, 0);
        this.controls.minDistance = 0.0001;
        this.controls.maxDistance = 1_000_000;
        this.camera.lookAt(this.controls.target);
        this.controls.update();
        this._updateClipPlanes();
        this.invalidate();
        if (emit) {
            this._cameraStateDirty = false;
            this._emitState();
        }
        return true;
    }

    setViewPreset(preset = "perspective", { emit = true } = {}) {
        const directions = {
            perspective: [0.62, 0.46, 0.78],
            front: [0, 0, 1],
            right: [1, 0, 0],
            top: [0, 1, 0.000001],
        };
        const direction = directions[preset] || directions.perspective;
        this.camera.up.set(0, 1, 0);
        if (preset === "top") this.camera.up.set(0, 0, -1);
        const box = this._viewBounds({ scope: "scene" });
        if (this._frameBounds(box, { direction, emit })) return true;
        const distance = Math.max(this.camera.position.distanceTo(this.controls.target), 1);
        this.camera.position.copy(this.controls.target).addScaledVector(
            new THREE.Vector3().fromArray(direction).normalize(),
            distance,
        );
        this.camera.lookAt(this.controls.target);
        this.controls.update();
        this._updateClipPlanes();
        this.invalidate();
        if (emit) this._emitState();
        return true;
    }

    orbitCamera({ yaw = 0, pitch = 0 } = {}, { emit = true } = {}) {
        const offset = this.camera.position.clone().sub(this.controls.target);
        if (offset.lengthSq() < 1e-12) offset.set(0.7, 0.5, 1);
        const spherical = new THREE.Spherical().setFromVector3(offset);
        spherical.theta += THREE.MathUtils.degToRad(Number(yaw) || 0);
        spherical.phi = THREE.MathUtils.clamp(
            spherical.phi + THREE.MathUtils.degToRad(Number(pitch) || 0),
            THREE.MathUtils.degToRad(1),
            THREE.MathUtils.degToRad(179),
        );
        this.camera.up.set(0, 1, 0);
        this.camera.position.copy(this.controls.target).add(
            new THREE.Vector3().setFromSpherical(spherical),
        );
        this.camera.lookAt(this.controls.target);
        this.controls.update();
        this._updateClipPlanes();
        this.invalidate();
        if (emit) {
            this._cameraStateDirty = false;
            this._emitState();
        }
    }

    panCamera({ right = 0, forward = 0 } = {}, { emit = true } = {}) {
        const distance = Math.max(this.camera.position.distanceTo(this.controls.target), 0.001);
        const viewForward = this.controls.target.clone().sub(this.camera.position);
        viewForward.y = 0;
        if (viewForward.lengthSq() < 1e-12) viewForward.set(0, 0, -1);
        viewForward.normalize();
        const viewRight = new THREE.Vector3().crossVectors(viewForward, new THREE.Vector3(0, 1, 0));
        if (viewRight.lengthSq() < 1e-12) viewRight.set(1, 0, 0);
        viewRight.normalize();
        const step = THREE.MathUtils.clamp(distance * 0.08, 0.01, 1000);
        const delta = viewRight.multiplyScalar((Number(right) || 0) * step)
            .addScaledVector(viewForward, (Number(forward) || 0) * step);
        if (delta.lengthSq() < 1e-12) return;
        this.camera.position.add(delta);
        this.controls.target.add(delta);
        this.camera.lookAt(this.controls.target);
        this.controls.update();
        this._updateClipPlanes();
        this.invalidate();
        if (emit) {
            this._cameraStateDirty = false;
            this._emitState();
        }
    }

    dollyCamera(amount = 0, { emit = true } = {}) {
        const units = Number(amount) || 0;
        if (!units) return;
        const distance = Math.max(this.camera.position.distanceTo(this.controls.target), 0.001);
        const forward = this.controls.target.clone().sub(this.camera.position);
        if (forward.lengthSq() < 1e-12) forward.set(0, 0, -1);
        const step = THREE.MathUtils.clamp(distance * 0.1, 0.01, 1000);
        const delta = forward.normalize().multiplyScalar(
            THREE.MathUtils.clamp(units, -10, 10) * step,
        );
        this.camera.position.add(delta);
        this.controls.target.add(delta);
        this.camera.lookAt(this.controls.target);
        this.controls.update();
        this._updateClipPlanes();
        this.invalidate();
        if (emit) {
            this._cameraStateDirty = false;
            this._emitState();
        }
    }

    setCameraDistance(value, { emit = true } = {}) {
        const distance = THREE.MathUtils.clamp(Number(value) || 0, 0.0001, 1_000_000);
        const direction = this.camera.position.clone().sub(this.controls.target);
        if (direction.lengthSq() < 1e-12) direction.set(0.62, 0.46, 0.78);
        this.camera.position.copy(this.controls.target).addScaledVector(direction.normalize(), distance);
        this.camera.lookAt(this.controls.target);
        this.controls.update();
        this._updateClipPlanes();
        this.invalidate();
        if (emit) {
            this._cameraStateDirty = false;
            this._emitState();
        }
    }

    setCameraHeight(value, { emit = true } = {}) {
        const height = THREE.MathUtils.clamp(Number(value) || 0, -1_000_000, 1_000_000);
        const delta = height - this.camera.position.y;
        this.camera.position.y += delta;
        this.controls.target.y += delta;
        this.camera.lookAt(this.controls.target);
        this.controls.update();
        this._updateClipPlanes();
        this.invalidate();
        if (emit) {
            this._cameraStateDirty = false;
            this._emitState();
        }
    }

    _updateClipPlanes(radiusHint = 0) {
        const distance = Math.max(this.camera.position.distanceTo(this.controls.target), radiusHint, 0.001);
        const near = Math.max(0.000001, distance / 100000);
        const far = Math.max(1000, distance * 100000);
        const changed = (
            Math.abs(this.camera.near - near) > Math.max(1e-9, near * 1e-5)
            || Math.abs(this.camera.far - far) > Math.max(1e-3, far * 1e-5)
        );
        if (!changed) return;
        this.camera.near = near;
        this.camera.far = far;
        this.camera.updateProjectionMatrix();
    }

    getState() {
        return {
            selected_object_id: this.selectedId,
            selected_group_id: this.selectedGroupId,
            mode: this.mode,
            grid: this.gridVisible,
            view_mode: this.viewMode,
            plan_tool: this.planTool,
            active_level_id: this.activeLevelId,
            plan_camera: {
                target: [...this.planCameraState.target],
                zoom: this.planCameraState.zoom,
            },
            camera: this.getCameraState(),
        };
    }

    getCameraState() {
        return {
            position: this.camera.position.toArray(),
            target: this.controls.target.toArray(),
            up: this.camera.up.toArray(),
            fov: this.captureFov,
        };
    }

    setCameraState(value = {}, { emit = false } = {}) {
        const position = finiteVector(value.position, this.camera.position.toArray());
        const target = finiteVector(value.target, this.controls.target.toArray());
        const up = finiteVector(value.up, this.camera.up.toArray());
        const fov = Number(value.fov);
        if (Number.isFinite(fov)) this.captureFov = Math.max(5, Math.min(120, fov));
        this.camera.position.fromArray(position);
        this.camera.up.fromArray(up);
        if (this.camera.up.lengthSq() < 1e-12) this.camera.up.set(0, 1, 0);
        this.camera.up.normalize();
        this.controls.target.fromArray(target);
        if (this.camera.position.distanceToSquared(this.controls.target) < 1e-12) {
            this.controls.target.set(position[0], position[1], position[2] - 1);
        }
        this.camera.lookAt(this.controls.target);
        this.controls.update();
        this._updateCameraProjection();
        this._updateCameraFrame();
        this._updateClipPlanes();
        this._cameraStateDirty = false;
        this.invalidate();
        if (emit) this._emitState();
    }

    setCameraPlayback(active) {
        const playing = Boolean(active);
        this.controls.enableDamping = !playing;
        this.controls.enabled = !playing && this.viewMode === "3d" && !this.transform.dragging;
        if (!playing) this.controls.update();
        this.invalidate();
    }

    rotateCameraFPV({ yaw = 0, pitch = 0 } = {}, { emit = true } = {}) {
        const yawRadians = THREE.MathUtils.degToRad(Number(yaw) || 0);
        const pitchRadians = THREE.MathUtils.degToRad(Number(pitch) || 0);
        if (!yawRadians && !pitchRadians) return;
        const distance = Math.max(
            this.camera.position.distanceTo(this.controls.target),
            0.001,
        );
        const worldUp = new THREE.Vector3(0, 1, 0);
        const forward = this.controls.target.clone()
            .sub(this.camera.position)
            .normalize();
        if (yawRadians) forward.applyAxisAngle(worldUp, yawRadians).normalize();
        if (pitchRadians) {
            const currentPitch = Math.asin(THREE.MathUtils.clamp(
                forward.dot(worldUp),
                -1,
                1,
            ));
            const maximumPitch = THREE.MathUtils.degToRad(89);
            const targetPitch = THREE.MathUtils.clamp(
                currentPitch + pitchRadians,
                -maximumPitch,
                maximumPitch,
            );
            const appliedPitch = targetPitch - currentPitch;
            const right = new THREE.Vector3().crossVectors(forward, worldUp);
            if (right.lengthSq() > 1e-12 && Math.abs(appliedPitch) > 1e-12) {
                forward.applyAxisAngle(right.normalize(), appliedPitch).normalize();
            }
        }
        this.controls.target.copy(this.camera.position).addScaledVector(forward, distance);
        // The look pad owns yaw/pitch only. Rebuilding from world-up prevents
        // local quaternion composition from accumulating an unintended roll.
        this.camera.up.copy(worldUp);
        this.camera.lookAt(this.controls.target);
        this.controls.update();
        this._updateClipPlanes();
        this._cameraStateDirty = false;
        this.invalidate();
        if (emit) this._emitState();
    }

    setState(value = {}) {
        if (value.mode) this.setMode(value.mode);
        if ("grid" in value) this.setGrid(value.grid);
        if (value.plan_camera) {
            this.planCameraState = {
                target: finiteVector(
                    [value.plan_camera.target?.[0], value.plan_camera.target?.[1], 0],
                    [0, 0, 0],
                ).slice(0, 2),
                zoom: Math.max(0.01, Number(value.plan_camera.zoom) || 24),
            };
        }
        if (value.active_level_id) this.setActiveLevel(value.active_level_id);
        if (value.plan_tool) this.setPlanTool(value.plan_tool);
        this.setCameraState(value.camera || {}, { emit: false });
        if (value.view_mode) this.setViewMode(value.view_mode);
    }

    _emitState() {
        if (!this._disposed) this.options.onStateChange(this.getState());
    }

    async _waitForRenderable(timeoutMs = 15000) {
        if (Number(this.spark.activeSplats) > 0 || this.architecture.root.children.length > 0) {
            return Math.max(1, Number(this.spark.activeSplats) || 0);
        }
        const started = performance.now();
        this.spark.setDirty?.();
        while (!this._disposed && performance.now() - started < timeoutMs) {
            await new Promise(resolve => setTimeout(resolve, 32));
            this.renderer.render(this.scene, this.activeCamera());
            if (Number(this.spark.activeSplats) > 0 || this.architecture.root.children.length > 0) {
                return Math.max(1, Number(this.spark.activeSplats) || 0);
            }
        }
        throw new Error(
            `3D viewport did not produce renderable scene content within ${Math.round(timeoutMs / 1000)} seconds`,
        );
    }

    async capturePreview({
        width = this.captureWidth,
        height = this.captureHeight,
        cameraState = null,
    } = {}) {
        if (this._disposed) throw new Error("3D viewport has been disposed");
        const targetWidth = Math.max(64, Math.min(4096, Math.round(Number(width) || 1024)));
        const targetHeight = Math.max(64, Math.min(4096, Math.round(Number(height) || 1024)));
        let captureSkydomeTexture = null;
        const editorSkydomeTexture = this.skydomeTexture;
        const skydomeSource = String(this.skydome?.source_url || "");
        if (
            this.hasVisibleSkydome()
            && skydomeSource
            && Math.max(targetWidth, targetHeight) > 2048
        ) {
            try {
                captureSkydomeTexture = await this._loadSkydomeTexture(skydomeSource);
            } catch (error) {
                console.warn(
                    "[VNCCS 3D Factory][viewport] Full-resolution skydome unavailable for export",
                    error,
                );
            }
        }
        const hasVisibleObjects = Array.from(this.objects.values()).some(
            entry => entry.mesh?.visible !== false,
        );
        try {
            if (hasVisibleObjects) await this._waitForRenderable();
        } catch (error) {
            captureSkydomeTexture?.dispose?.();
            throw error;
        }
        if (this._disposed) {
            captureSkydomeTexture?.dispose?.();
            throw new Error("3D viewport was disposed while preparing the preview");
        }

        let target = null;
        const originalPixelRatio = this.renderer.getPixelRatio();
        const overlayVisibility = {
            grid: this.grid.visible,
            transform: this.transformHelper.visible,
            bounds: this.selectionBounds.visible,
            plan: this.planOverlay.visible,
        };
        const previousCaptureState = this._capturing;
        this.grid.visible = false;
        this.transformHelper.visible = false;
        this.selectionBounds.visible = false;
        this.planOverlay.visible = false;
        this.architecture.setActiveLevel(this.activeLevelId, false);
        this._capturing = true;
        if (captureSkydomeTexture) {
            this.skydomeTexture = captureSkydomeTexture;
            this._applySkydomeSettings();
        }

        try {
            if (cameraState) {
                const position = finiteVector(
                    cameraState.position,
                    this.camera.position.toArray(),
                );
                const targetState = finiteVector(
                    cameraState.target,
                    this.controls.target.toArray(),
                );
                const up = finiteVector(cameraState.up, this.camera.up.toArray());
                this.captureCamera.position.fromArray(position);
                this.captureCamera.up.fromArray(up);
                if (this.captureCamera.up.lengthSq() < 1e-12) {
                    this.captureCamera.up.set(0, 1, 0);
                }
                this.captureCamera.up.normalize();
                const targetVector = new THREE.Vector3().fromArray(targetState);
                if (this.captureCamera.position.distanceToSquared(targetVector) < 1e-12) {
                    targetVector.set(position[0], position[1], position[2] - 1);
                }
                this.captureCamera.lookAt(targetVector);
                const distance = Math.max(
                    this.captureCamera.position.distanceTo(targetVector),
                    0.001,
                );
                this.captureCamera.near = Math.max(0.000001, distance / 100000);
                this.captureCamera.far = Math.max(1000, distance * 100000);
            } else {
                this.captureCamera.position.copy(this.camera.position);
                this.captureCamera.quaternion.copy(this.camera.quaternion);
                this.captureCamera.up.copy(this.camera.up);
                this.captureCamera.near = this.camera.near;
                this.captureCamera.far = this.camera.far;
            }
            this.captureCamera.aspect = targetWidth / targetHeight;
            const requestedFov = Number(cameraState?.fov);
            this.captureCamera.fov = Number.isFinite(requestedFov)
                ? Math.max(5, Math.min(120, requestedFov))
                : this.captureFov;
            this.captureCamera.updateProjectionMatrix();
            this.captureCamera.updateMatrixWorld(true);

            // Render into an exact, device-pixel-ratio-independent drawing
            // buffer. The node output no longer inherits the widget's DOM size.
            this.renderer.setPixelRatio(1);
            this.renderer.setSize(targetWidth, targetHeight, false);
            this.spark.setDirty?.();
            await this.spark.update({ scene: this.scene, camera: this.captureCamera });
            this.renderer.render(this.scene, this.captureCamera);
            target = document.createElement("canvas");
            target.width = targetWidth;
            target.height = targetHeight;
            const context = target.getContext("2d", { alpha: false });
            if (!context) throw new Error("Could not create the 3D preview canvas");
            context.drawImage(this.canvas, 0, 0, targetWidth, targetHeight);
        } finally {
            this.renderer.setPixelRatio(originalPixelRatio);
            this._currentPixelRatio = originalPixelRatio;
            this._viewportWidth = 0;
            this._viewportHeight = 0;
            if (captureSkydomeTexture) {
                this.skydomeTexture = editorSkydomeTexture;
                this._applySkydomeSettings();
                captureSkydomeTexture.dispose();
            }
            this.grid.visible = overlayVisibility.grid;
            this.transformHelper.visible = overlayVisibility.transform;
            this.selectionBounds.visible = overlayVisibility.bounds;
            this.planOverlay.visible = overlayVisibility.plan;
            this.architecture.setActiveLevel(this.activeLevelId, this.viewMode === "plan");
            this._capturing = previousCaptureState;
            // Re-read the local viewport after capture. The Comfy graph may
            // have been zoomed or the node resized while the exact-size render
            // was being encoded.
            this.resize();
            this.renderer.render(this.scene, this.activeCamera());
            this.invalidate();
        }
        return await new Promise((resolve, reject) => {
            target.toBlob(
                blob => blob
                    ? resolve(blob)
                    : reject(new Error("Could not encode the 3D scene preview")),
                "image/png",
            );
        });
    }

    async captureSkydomePreview({
        width = 640,
        height = 640,
    } = {}) {
        if (!this.skydomeTexture || !this.skydome) return null;
        const skydome = this.skydome;
        const objectState = new Map();
        for (const [id, value] of this.objects) {
            const parent = value.mesh.parent;
            objectState.set(id, {
                parent,
                parentIndex: parent ? parent.children.indexOf(value.mesh) : -1,
                rootVisible: value.mesh.visible,
                splatVisible: value.splat.visible,
            });
        }
        const previousSkydomeVisible = skydome.visible;
        const previousSuppressState = this._suppressStateEvents;
        const previousCaptureState = this._capturing;
        this._suppressStateEvents = true;
        this._capturing = true;
        try {
            // Spark retains its own generated mapping, so remove every
            // Gaussian root as well as hiding it. This guarantees that a
            // library preview for a skydome contains only the environment.
            for (const value of this.objects.values()) {
                value.mesh.visible = false;
                value.splat.visible = false;
                value.mesh.parent?.remove(value.mesh);
            }
            skydome.visible = true;
            this._applySkydomeSettings();
            this.spark.setDirty?.();
            await this.spark.update({ scene: this.scene, camera: this.camera });
            return await this.capturePreview({ width, height });
        } finally {
            try {
                if (this.skydome === skydome) {
                    skydome.visible = previousSkydomeVisible;
                    this._applySkydomeSettings();
                }
                for (const [id, state] of objectState) {
                    const value = this.objects.get(id);
                    if (!value) continue;
                    if (state.parent && value.mesh.parent !== state.parent) {
                        state.parent.add(value.mesh);
                        const currentIndex = state.parent.children.indexOf(value.mesh);
                        if (
                            state.parentIndex >= 0
                            && currentIndex >= 0
                            && currentIndex !== state.parentIndex
                        ) {
                            state.parent.children.splice(currentIndex, 1);
                            state.parent.children.splice(state.parentIndex, 0, value.mesh);
                        }
                    }
                    value.mesh.visible = state.rootVisible;
                    value.splat.visible = state.splatVisible;
                    value.mesh.updateMatrixWorld(true);
                }
                this._refreshSelectionBounds();
                this.spark.setDirty?.();
                try {
                    await this.spark.update({ scene: this.scene, camera: this.camera });
                } catch (error) {
                    this.options.onError(error);
                }
                this.renderer.render(this.scene, this.activeCamera());
                this.invalidate();
            } finally {
                this._capturing = previousCaptureState;
                this._suppressStateEvents = previousSuppressState;
            }
        }
    }

    async captureObjectPreview(objectId, {
        width = 640,
        height = 640,
    } = {}) {
        const entry = this.objects.get(objectId);
        if (!entry) throw new Error("The selected Gaussian object is not loaded");
        const cameraState = {
            position: this.camera.position.clone(),
            quaternion: this.camera.quaternion.clone(),
            up: this.camera.up.clone(),
            target: this.controls.target.clone(),
            near: this.camera.near,
            far: this.camera.far,
        };
        const objectState = new Map();
        for (const [id, value] of this.objects) {
            const parent = value.mesh.parent;
            objectState.set(id, {
                parent,
                parentIndex: parent ? parent.children.indexOf(value.mesh) : -1,
                rootVisible: value.mesh.visible,
                splatVisible: value.splat.visible,
                position: value.mesh.position.clone(),
                quaternion: value.mesh.quaternion.clone(),
                scale: value.mesh.scale.clone(),
            });
        }
        const previousSuppressState = this._suppressStateEvents;
        const previousCaptureState = this._capturing;
        this._suppressStateEvents = true;
        this._capturing = true;
        try {
            for (const [id, value] of this.objects) {
                const selected = id === objectId;
                value.mesh.visible = selected;
                value.splat.visible = selected;
                if (!selected) value.mesh.parent?.remove(value.mesh);
            }
            // Remove every scene transform. The child SplatMesh retains only
            // triposplatCanonicalMatrix(), which defines the generated
            // object's real front independently of placement in the scene.
            entry.mesh.position.set(0, 0, 0);
            entry.mesh.quaternion.identity();
            entry.mesh.scale.setScalar(1);
            entry.mesh.updateMatrixWorld(true);
            this._syncDirectionalLighting(entry);

            const previewCamera = canonicalObjectPreviewCamera(
                entry.localBounds,
                width,
                height,
                this.captureFov,
            );
            this.camera.position.copy(previewCamera.position);
            this.camera.up.copy(previewCamera.up);
            this.controls.target.copy(previewCamera.target);
            this.camera.lookAt(previewCamera.target);
            this.camera.near = previewCamera.near;
            this.camera.far = previewCamera.far;
            this.camera.updateProjectionMatrix();
            this.camera.updateMatrixWorld(true);
            this.controls.update();
            this.spark.setDirty?.();
            // Spark keeps a generated mapping separate from the Three scene
            // graph. Rebuild it synchronously after isolation; otherwise the
            // previous mapping (usually the first loaded object) can be drawn
            // even though its Object3D has already been removed.
            await this.spark.update({ scene: this.scene, camera: this.camera });
            return await this.capturePreview({ width, height });
        } finally {
            try {
                for (const [id, state] of objectState) {
                    const value = this.objects.get(id);
                    if (!value) continue;
                    if (state.parent && value.mesh.parent !== state.parent) {
                        state.parent.add(value.mesh);
                        const currentIndex = state.parent.children.indexOf(value.mesh);
                        if (
                            state.parentIndex >= 0
                            && currentIndex >= 0
                            && currentIndex !== state.parentIndex
                        ) {
                            state.parent.children.splice(currentIndex, 1);
                            state.parent.children.splice(state.parentIndex, 0, value.mesh);
                        }
                    }
                    value.mesh.position.copy(state.position);
                    value.mesh.quaternion.copy(state.quaternion);
                    value.mesh.scale.copy(state.scale);
                    value.mesh.visible = state.rootVisible;
                    value.splat.visible = state.splatVisible;
                    value.mesh.updateMatrixWorld(true);
                    this._syncDirectionalLighting(value);
                }
                this.camera.position.copy(cameraState.position);
                this.camera.quaternion.copy(cameraState.quaternion);
                this.camera.up.copy(cameraState.up);
                this.controls.target.copy(cameraState.target);
                this.camera.near = cameraState.near;
                this.camera.far = cameraState.far;
                this.camera.updateProjectionMatrix();
                this.controls.update();
                this._refreshSelectionBounds();
                this.spark.setDirty?.();
                try {
                    await this.spark.update({ scene: this.scene, camera: this.camera });
                } catch (error) {
                    this.options.onError(error);
                }
                this.renderer.render(this.scene, this.activeCamera());
            } finally {
                this._capturing = previousCaptureState;
                this._suppressStateEvents = previousSuppressState;
            }
        }
    }

    dispose() {
        if (this._disposed) return;
        this._disposed = true;
        this._loadingToken += 1;
        this._skydomeLoadToken += 1;
        this._loadController?.abort();
        this._loadController = null;
        clearTimeout(this._lightingUpdateTimer);
        clearTimeout(this._qualityRestoreTimer);
        this._lightingUpdateTimer = 0;
        this._qualityRestoreTimer = 0;
        this._pendingLightingEntries.clear();
        this._qualityInteractionReasons.clear();
        this._cancelScheduledFrame();
        this._resizeObserver?.disconnect();
        this._intersectionObserver?.disconnect();
        if (this._visibilityHandler) {
            document.removeEventListener("visibilitychange", this._visibilityHandler);
        }
        this.transform.detach();
        this.transform.dispose();
        this.scene.remove(this.transformHelper);
        this.scene.remove(this.selectionBounds);
        this.selectionBounds.geometry.dispose();
        this.selectionBounds.material.dispose();
        this.controls.dispose();
        this.architecture?.dispose?.();
        this._clearPlanRoot(this.planGridRoot);
        this._clearPlanRoot(this.planDraftRoot);
        this._clearPlanRoot(this.cameraMarkerRoot);
        this._clearPlanRoot(this.architectureHandleRoot);
        this.scene.remove(this.planOverlay);
        for (const entry of this.objects.values()) this._disposeEntry(entry);
        this.objects.clear();
        this.skydomeTexture?.dispose?.();
        this.skydomeTexture = null;
        this.skydome = null;
        this.scene.remove(this.spark);
        this.spark.onDirty = null;
        this.spark?.dispose?.();
        for (const child of this.lightRig.children) child.shadow?.map?.dispose?.();
        this.scene.remove(this.lightRig);
        this.grid.geometry.dispose();
        this.grid.material.dispose();
        this.renderer.dispose();
        this.cameraFrame?.remove();
        this.canvas.remove();
    }
}

export default Factory3DViewer;
