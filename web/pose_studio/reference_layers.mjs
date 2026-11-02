/**
 * Pose Studio reference image layers: data model and transform math.
 *
 * Reference layers are editor-only tracing images. They live in capture-frame
 * space: units of one frame height, origin at the frame centre, +x right and
 * +y up. The frame height is fixed by the capture camera, so a layer keeps its
 * place relative to the character when the output width or height changes and
 * stays glued to the orange frame when the editor view orbits or zooms.
 * Output pixels: px = W / 2 + x * H, py = H / 2 - y * H.
 *
 * `rotation` is in degrees, clockwise on screen (image-editor convention).
 * `scale` is the layer height in frame heights (1 = as tall as the frame).
 * Layers are stored bottom to top: index 0 is drawn first.
 */

export const REFERENCE_LAYER_LIMIT = 8;
// Images are downscaled on import so the workflow stays small (the existing
// background image is stored inline in pose_data the same way).
export const REFERENCE_LAYER_MAX_EDGE = 1024;
export const REFERENCE_LAYER_MAX_FILE_BYTES = 40 * 1024 * 1024;
export const REFERENCE_LAYER_MAX_SRC_LENGTH = 6 * 1024 * 1024;
export const REFERENCE_LAYER_SCALE_MIN = 0.01;
export const REFERENCE_LAYER_SCALE_MAX = 20;
const POSITION_LIMIT = 50;
const NAME_LIMIT = 80;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const finite = (value, fallback) => {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
};
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function normalizeRotation(degrees) {
    let value = finite(degrees, 0) % 360;
    if (value > 180) value -= 360;
    if (value <= -180) value += 360;
    return Object.is(value, -0) ? 0 : value;
}

export function createReferenceLayerId(existing = []) {
    const used = new Set(existing);
    for (;;) {
        const id = `ref_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        if (!used.has(id)) return id;
    }
}

function normalizeTransform(raw, base) {
    return {
        visible: raw.visible === undefined ? base.visible : raw.visible !== false,
        locked: raw.locked === undefined ? base.locked : raw.locked === true,
        flipX: raw.flipX === undefined ? base.flipX : raw.flipX === true,
        opacity: clamp(finite(raw.opacity, base.opacity), 0, 1),
        x: clamp(finite(raw.x, base.x), -POSITION_LIMIT, POSITION_LIMIT),
        y: clamp(finite(raw.y, base.y), -POSITION_LIMIT, POSITION_LIMIT),
        scale: clamp(finite(raw.scale, base.scale), REFERENCE_LAYER_SCALE_MIN, REFERENCE_LAYER_SCALE_MAX),
        rotation: normalizeRotation(finite(raw.rotation, base.rotation)),
    };
}

const DEFAULT_TRANSFORM = Object.freeze({
    visible: true, locked: false, flipX: false, opacity: 0.5, x: 0, y: 0, scale: 1, rotation: 0,
});

/** Returns a clean copy of `patch` applied to `layer`, with every value clamped. */
export function patchReferenceLayer(layer, patch = {}) {
    const next = { ...layer, ...normalizeTransform({ ...layer, ...patch }, layer) };
    if (patch.name !== undefined) next.name = String(patch.name).slice(0, NAME_LIMIT);
    return next;
}

function normalizeMeta(raw, index) {
    const width = Math.round(finite(raw.width, 0));
    const height = Math.round(finite(raw.height, 0));
    if (width < 1 || height < 1 || width > 16384 || height > 16384) return null;
    return {
        id: typeof raw.id === "string" && ID_PATTERN.test(raw.id) ? raw.id : `ref_${index + 1}`,
        name: typeof raw.name === "string" && raw.name ? raw.name.slice(0, NAME_LIMIT) : `Reference ${index + 1}`,
        width,
        height,
    };
}

export function isReferenceLayerSource(src) {
    return typeof src === "string" && src.length <= REFERENCE_LAYER_MAX_SRC_LENGTH
        && /^data:image\/[a-z0-9.+-]+;base64,/i.test(src);
}

/** Validates one stored layer. Invalid entries return null and are dropped. */
export function normalizeReferenceLayer(raw, index = 0) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || !isReferenceLayerSource(raw.src)) return null;
    const meta = normalizeMeta(raw, index);
    if (!meta) return null;
    return { ...meta, src: raw.src, ...normalizeTransform(raw, DEFAULT_TRANSFORM) };
}

function uniqueIds(layers) {
    const used = new Set();
    return layers.map(layer => {
        if (!used.has(layer.id)) {
            used.add(layer.id);
            return layer;
        }
        const id = createReferenceLayerId(used);
        used.add(id);
        return { ...layer, id };
    });
}

/** Restores the saved list. Old workflows (no list) load with no layers. */
export function normalizeReferenceLayers(raw) {
    if (!Array.isArray(raw)) return [];
    const layers = raw.map((item, index) => normalizeReferenceLayer(item, index)).filter(Boolean);
    return uniqueIds(layers.slice(-REFERENCE_LAYER_LIMIT));
}

const STORED_KEYS = ["id", "name", "src", "width", "height", "visible", "locked", "flipX", "opacity", "x", "y", "scale", "rotation"];
const HISTORY_KEYS = STORED_KEYS.filter(key => key !== "src");
const pick = (layer, keys) => Object.fromEntries(keys.map(key => [key, layer[key]]));

/** Workflow form; undefined when empty so workflows without layers stay unchanged. */
export function serializeReferenceLayers(layers) {
    if (!Array.isArray(layers) || !layers.length) return undefined;
    return layers.map(layer => pick(layer, STORED_KEYS));
}

/** Undo form: everything except the image data, which stays in `images`. */
export function referenceLayerHistorySnapshot(layers) {
    return (Array.isArray(layers) ? layers : []).map(layer => pick(layer, HISTORY_KEYS));
}

export function restoreReferenceLayerHistory(snapshot, images) {
    if (!Array.isArray(snapshot)) return [];
    const layers = [];
    snapshot.forEach((entry, index) => {
        const src = entry && images?.get?.(entry.id);
        const layer = src ? normalizeReferenceLayer({ ...entry, src }, index) : null;
        if (layer) layers.push(layer);
    });
    return uniqueIds(layers.slice(-REFERENCE_LAYER_LIMIT));
}

/** Initial height so the whole image fits inside the frame. */
export function fitReferenceLayerScale(imageWidth, imageHeight, frameAspect) {
    const imageAspect = finite(imageWidth, 1) / Math.max(1, finite(imageHeight, 1));
    const aspect = finite(frameAspect, 1) > 0 ? finite(frameAspect, 1) : 1;
    return clamp(Math.min(1, aspect / imageAspect), REFERENCE_LAYER_SCALE_MIN, REFERENCE_LAYER_SCALE_MAX);
}

export function createReferenceLayer({ id, name, src, width, height }, frameAspect = 1, existingIds = []) {
    return normalizeReferenceLayer({
        id: id || createReferenceLayerId(existingIds),
        name,
        src,
        width,
        height,
        scale: fitReferenceLayerScale(width, height, frameAspect),
    });
}

export function referenceLayerHalfSize(layer) {
    const hy = layer.scale / 2;
    return { hx: hy * (layer.width / layer.height), hy };
}

const angleOf = layer => -normalizeRotation(layer.rotation) * Math.PI / 180;

export function layerLocalToFrame(layer, local) {
    const angle = angleOf(layer), cos = Math.cos(angle), sin = Math.sin(angle);
    return {
        x: layer.x + local.x * cos - local.y * sin,
        y: layer.y + local.x * sin + local.y * cos,
    };
}

export function frameToLayerLocal(layer, point) {
    const angle = angleOf(layer), cos = Math.cos(angle), sin = Math.sin(angle);
    const dx = point.x - layer.x, dy = point.y - layer.y;
    return { x: dx * cos + dy * sin, y: -dx * sin + dy * cos };
}

/** Corners in frame space: top-left, top-right, bottom-right, bottom-left. */
export function referenceLayerCorners(layer) {
    const { hx, hy } = referenceLayerHalfSize(layer);
    return [[-hx, hy], [hx, hy], [hx, -hy], [-hx, -hy]].map(([x, y]) => layerLocalToFrame(layer, { x, y }));
}

export function hitTestReferenceLayer(layer, point) {
    if (!layer || !point) return false;
    const { hx, hy } = referenceLayerHalfSize(layer);
    const local = frameToLayerLocal(layer, point);
    return Math.abs(local.x) <= hx && Math.abs(local.y) <= hy;
}

/**
 * Transform patch for a pointer gesture. Always derived from the state at
 * gesture start so the result never drifts while the pointer moves.
 */
export function dragReferenceLayer(mode, start, startPoint, point, { snap = false } = {}) {
    if (mode === "move") {
        return { x: start.x + point.x - startPoint.x, y: start.y + point.y - startPoint.y };
    }
    if (mode === "scale") {
        const from = Math.hypot(startPoint.x - start.x, startPoint.y - start.y);
        const to = Math.hypot(point.x - start.x, point.y - start.y);
        if (from < 1e-6) return { scale: start.scale };
        return { scale: clamp(start.scale * to / from, REFERENCE_LAYER_SCALE_MIN, REFERENCE_LAYER_SCALE_MAX) };
    }
    if (mode === "rotate") {
        const from = Math.atan2(startPoint.y - start.y, startPoint.x - start.x);
        const to = Math.atan2(point.y - start.y, point.x - start.x);
        let rotation = start.rotation - (to - from) * 180 / Math.PI;
        if (snap) rotation = Math.round(rotation / 15) * 15;
        return { rotation: normalizeRotation(rotation) };
    }
    return {};
}

/** Moves a layer toward the top (+1) or bottom (-1) of the stack. */
export function reorderReferenceLayers(layers, id, direction) {
    const index = layers.findIndex(layer => layer.id === id);
    const target = index + Math.sign(direction);
    if (index < 0 || target < 0 || target >= layers.length) return layers;
    const next = layers.slice();
    [next[index], next[target]] = [next[target], next[index]];
    return next;
}

export function frameToOutputPixels(point, width, height) {
    return { x: width / 2 + point.x * height, y: height / 2 - point.y * height };
}

export function outputPixelsToFrame(pixel, width, height) {
    return { x: (pixel.x - width / 2) / height, y: (height / 2 - pixel.y) / height };
}

/**
 * Pointer to normalized device coordinates. ComfyUI CSS-scales node DOM, so
 * the bounding rect is zoomed while clientWidth is not; using the rect for
 * the ratio keeps the mapping correct at every canvas zoom.
 */
export function clientToNdc(clientX, clientY, rect) {
    return {
        x: ((clientX - rect.left) / Math.max(1e-6, rect.width)) * 2 - 1,
        y: -((clientY - rect.top) / Math.max(1e-6, rect.height)) * 2 + 1,
    };
}

/** NDC to unzoomed CSS pixels of an element (its clientWidth/clientHeight). */
export function ndcToCssPixels(ndc, width, height) {
    return { x: (ndc.x + 1) / 2 * width, y: (1 - ndc.y) / 2 * height };
}
