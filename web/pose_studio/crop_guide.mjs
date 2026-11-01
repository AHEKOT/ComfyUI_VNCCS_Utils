/**
 * Pose Studio crop guide: one framing rectangle per static pose tab.
 *
 * The rectangle lives in the post-projection image space of the capture:
 * normalized 0..1 coordinates, origin top-left, +x right, +y down, no rotation,
 * always fully inside the image. It never changes the capture camera, the pose
 * or `images`; it only describes where the final image should be cropped.
 *
 * Pure coordinate math shared by the editor overlay (crop_guide_overlay.mjs) and
 * mirrored exactly by nodes/posestudio/crop_guide.py, so the same JSON and image
 * size always give the same pixel rectangle in the browser and in Python.
 */

export const CROP_GUIDE_SCHEMA_VERSION = 1;
/** Smallest rectangle the editor creates, in output pixels (or the image size if smaller). */
export const CROP_GUIDE_MIN_PIXELS = 8;
/** Products closer than this to an integer count as that integer (float error, e.g. 0.1 * 1000). */
export const CROP_GUIDE_PIXEL_EPSILON = 1e-6;

/** Aspect presets: ratios of the final crop in PIXELS (width / height), not normalized units. */
export const CROP_GUIDE_ASPECT_PRESETS = Object.freeze([
    Object.freeze({ key: "free", label: "Free", ratio: null }),
    Object.freeze({ key: "1:1", label: "1:1", ratio: 1 }),
    Object.freeze({ key: "4:3", label: "4:3", ratio: 4 / 3 }),
    Object.freeze({ key: "3:4", label: "3:4", ratio: 3 / 4 }),
    Object.freeze({ key: "16:9", label: "16:9", ratio: 16 / 9 }),
    Object.freeze({ key: "9:16", label: "9:16", ratio: 9 / 16 }),
    Object.freeze({ key: "custom", label: "Custom", ratio: null }),
]);
const PRESET_KEYS = new Set(CROP_GUIDE_ASPECT_PRESETS.map(preset => preset.key));

/** Node outputs appended after the existing Pose Studio outputs, in slot order. */
export const POSE_CROP_GUIDE_OUTPUTS = Object.freeze([
    Object.freeze({ name: "crop_json", type: "STRING" }),
    Object.freeze({ name: "crop_image", type: "IMAGE" }),
    Object.freeze({ name: "crop_preview", type: "IMAGE" }),
]);

/** Names of the crop outputs that are linked on a ComfyUI node, in slot order. */
export function poseCropGuideOutputNames(node) {
    const linked = new Set((node?.outputs || [])
        .filter(output => Array.isArray(output?.links) && output.links.length > 0)
        .map(output => output.name));
    return POSE_CROP_GUIDE_OUTPUTS.map(output => output.name).filter(name => linked.has(name));
}

/** Workflows saved before the crop outputs existed only gain them at the end; earlier slots and links stay. */
export function ensurePoseCropGuideOutputs(node) {
    if (!Array.isArray(node?.outputs) || typeof node.addOutput !== "function") return;
    for (const output of POSE_CROP_GUIDE_OUTPUTS) {
        if (!node.outputs.some(existing => existing?.name === output.name)) node.addOutput(output.name, output.type);
    }
}

export function defaultCropGuide() {
    return {
        schema_version: CROP_GUIDE_SCHEMA_VERSION,
        enabled: false,
        x: 0.1,
        y: 0.1,
        width: 0.8,
        height: 0.8,
        aspect_ratio: "free",
        custom_aspect_ratio: [1, 1],
        aspect_ratio_locked: false,
    };
}

function finite(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    return null;
}

const clamp = (value, low, high) => Math.min(Math.max(value, low), high);

/**
 * Lenient normalization for editor and workflow data: NaN, Infinity, negative,
 * oversized or non-numeric rectangles fall back to the default rectangle and the
 * guide is disabled; valid rectangles are clamped fully inside the image.
 * Data saved before the crop guide existed (undefined) loads as disabled.
 */
export function normalizeCropGuide(value) {
    const guide = defaultCropGuide();
    if (!value || typeof value !== "object" || Array.isArray(value)) return guide;
    const x = finite(value.x), y = finite(value.y), width = finite(value.width), height = finite(value.height);
    const rectValid = [x, y, width, height].every(number => number !== null) && width > 0 && height > 0;
    if (rectValid) {
        guide.width = Math.min(width, 1);
        guide.height = Math.min(height, 1);
        guide.x = clamp(x, 0, 1 - guide.width);
        guide.y = clamp(y, 0, 1 - guide.height);
    }
    guide.enabled = value.enabled === true && rectValid;
    if (typeof value.aspect_ratio === "string" && PRESET_KEYS.has(value.aspect_ratio)) {
        guide.aspect_ratio = value.aspect_ratio;
    }
    const custom = value.custom_aspect_ratio;
    if (Array.isArray(custom) && custom.length === 2) {
        const [cw, ch] = custom.map(finite);
        if (cw !== null && ch !== null && cw > 0 && ch > 0) guide.custom_aspect_ratio = [cw, ch];
    }
    guide.aspect_ratio_locked = guide.aspect_ratio !== "free" || value.aspect_ratio_locked === true;
    return guide;
}

/** Pixel aspect ratio (width / height) required by the preset, or null for Free. */
export function cropGuidePresetRatio(guide) {
    if (guide?.aspect_ratio === "custom") {
        const [cw, ch] = guide.custom_aspect_ratio || [1, 1];
        return cw / ch;
    }
    return CROP_GUIDE_ASPECT_PRESETS.find(preset => preset.key === guide?.aspect_ratio)?.ratio ?? null;
}

/** Ratio the editor keeps while resizing: the preset, the current shape when Free is locked, else null. */
export function cropGuideLockedRatio(guide, width, height) {
    const preset = cropGuidePresetRatio(guide);
    if (preset !== null) return preset;
    if (guide?.aspect_ratio_locked !== true) return null;
    return (guide.width * width) / (guide.height * height);
}

function snapPixel(value) {
    const nearest = Math.round(value);
    return Math.abs(value - nearest) <= CROP_GUIDE_PIXEL_EPSILON ? nearest : value;
}

function validSize(width, height) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
        throw new RangeError(`Crop guide image size must be positive integers, got ${width} x ${height}.`);
    }
}

/**
 * Normalized rectangle -> integer pixel rectangle of a `width` x `height` image.
 * Left/top use floor, right/bottom use ceil and are exclusive; everything is
 * clamped to the image and the result is at least 1 x 1. Width and height are
 * the differences of the boundaries, so neighbouring rectangles never overlap or gap.
 */
export function cropGuidePixelRect(rect, width, height) {
    validSize(width, height);
    const left = clamp(Math.floor(snapPixel(rect.x * width)), 0, width - 1);
    const top = clamp(Math.floor(snapPixel(rect.y * height)), 0, height - 1);
    const right = clamp(Math.ceil(snapPixel((rect.x + rect.width) * width)), left + 1, width);
    const bottom = clamp(Math.ceil(snapPixel((rect.y + rect.height) * height)), top + 1, height);
    return { x: left, y: top, width: right - left, height: bottom - top };
}

// --- Editing in pixel space ----------------------------------------------------
// Editor results are snapped to whole output pixels, so the numeric fields, the
// overlay and the crop show the same integers at the current output size. A box is
// { left, top, right, bottom } in (fractional) output pixels.

const HANDLES = new Set(["nw", "n", "ne", "e", "se", "s", "sw", "w"]);

function minimumSize(width, height) {
    return { w: Math.min(CROP_GUIDE_MIN_PIXELS, width), h: Math.min(CROP_GUIDE_MIN_PIXELS, height) };
}

function edges(guide, width, height) {
    return {
        left: snapPixel(guide.x * width),
        top: snapPixel(guide.y * height),
        right: snapPixel((guide.x + guide.width) * width),
        bottom: snapPixel((guide.y + guide.height) * height),
    };
}

/** Stores integer pixel edges normalized, exactly as normalizeCropGuide() would keep them. */
function store(guide, left, top, w, h, width, height) {
    const nw = w / width, nh = h / height;
    return {
        ...guide,
        x: clamp(left / width, 0, 1 - nw),
        y: clamp(top / height, 0, 1 - nh),
        width: nw,
        height: nh,
    };
}

/** Integer start of a span of `size` placed by its start, end or center, inside 0..limit. */
function place(start, end, size, limit, anchor) {
    const value = anchor === "start" ? Math.round(start)
        : anchor === "end" ? Math.round(end) - size
            : Math.round((start + end) / 2 - size / 2);
    return clamp(value, 0, limit - size);
}

/**
 * Snaps a box to whole pixels. With a ratio, the longer side is rounded first and
 * the other derived from it, so the pixel ratio is off by at most half a pixel.
 * `anchor` keeps the dragged box's start, end or center on each axis.
 */
function fromBox(guide, box, width, height, ratio = null, anchor = { x: "start", y: "start" }) {
    const min = minimumSize(width, height);
    let w = Math.round(box.right - box.left), h = Math.round(box.bottom - box.top);
    if (ratio) {
        if (ratio >= 1) {
            h = clamp(Math.round(box.bottom - box.top), min.h, height);
            w = Math.round(h * ratio);
            if (w > width) { w = width; h = clamp(Math.round(w / ratio), 1, height); }
        } else {
            w = clamp(Math.round(box.right - box.left), min.w, width);
            h = Math.round(w / ratio);
            if (h > height) { h = height; w = clamp(Math.round(h * ratio), 1, width); }
        }
    }
    w = clamp(w, min.w, width);
    h = clamp(h, min.h, height);
    const left = place(box.left, box.right, w, width, anchor.x);
    const top = place(box.top, box.bottom, h, height, anchor.y);
    return store(guide, left, top, w, h, width, height);
}

function sizeWithRatio(desiredWidth, ratio, maxWidth, maxHeight, min) {
    let w = Math.max(desiredWidth, min.w, min.h * ratio);
    w = Math.min(w, maxWidth, maxHeight * ratio);
    return { w, h: w / ratio };
}

/** Moves `start` by a normalized offset, keeping its pixel size and staying inside the image. */
export function moveCropGuide(start, du, dv, width, height) {
    validSize(width, height);
    const box = edges(start, width, height);
    const dx = (Number(du) || 0) * width, dy = (Number(dv) || 0) * height;
    return fromBox(start, { left: box.left + dx, top: box.top + dy, right: box.right + dx, bottom: box.bottom + dy }, width, height);
}

/**
 * Resizes `start` with a corner ("nw", "ne", "se", "sw") or edge ("n", "e", "s", "w")
 * handle dragged to the normalized point (u, v). The opposite corner or edge stays;
 * with a locked ratio, edges grow symmetrically around the other axis' center.
 */
export function resizeCropGuide(start, handle, u, v, width, height) {
    validSize(width, height);
    if (!HANDLES.has(handle)) throw new RangeError(`Unknown crop guide handle "${handle}".`);
    const box = edges(start, width, height);
    const px = clamp((Number(u) || 0) * width, 0, width), py = clamp((Number(v) || 0) * height, 0, height);
    const min = minimumSize(width, height);
    const ratio = cropGuideLockedRatio(start, width, height);
    const east = handle.includes("e"), west = handle.includes("w");
    const south = handle.includes("s"), north = handle.includes("n");
    const next = { ...box };
    const anchor = { x: "center", y: "center" };
    if (east || west) {
        const ax = east ? box.left : box.right;
        const maxW = east ? width - ax : ax;
        const desired = east ? px - ax : ax - px;
        let w = clamp(desired, min.w, maxW);
        if (ratio) {
            const desiredByHeight = north || south ? ((south ? py - box.top : box.bottom - py) * ratio) : -Infinity;
            w = sizeWithRatio(Math.max(desired, desiredByHeight), ratio, maxW, north || south ? (south ? height - box.top : box.bottom) : height, min).w;
        }
        next.left = east ? ax : ax - w; next.right = next.left + w;
        anchor.x = east ? "start" : "end";
        if (ratio && !(north || south)) {
            const h = w / ratio, cy = (box.top + box.bottom) / 2;
            next.top = clamp(cy - h / 2, 0, height - h); next.bottom = next.top + h;
        }
    }
    if (north || south) {
        const ay = south ? box.top : box.bottom;
        const maxH = south ? height - ay : ay;
        let h = clamp(south ? py - ay : ay - py, min.h, maxH);
        if (ratio && (east || west)) h = (next.right - next.left) / ratio;
        else if (ratio) {
            const sized = sizeWithRatio((south ? py - ay : ay - py) * ratio, ratio, width, maxH, min);
            h = sized.h;
            const cx = (box.left + box.right) / 2;
            next.left = clamp(cx - sized.w / 2, 0, width - sized.w); next.right = next.left + sized.w;
        }
        next.top = south ? ay : ay - h; next.bottom = next.top + h;
        anchor.y = south ? "start" : "end";
    }
    return fromBox(start, next, width, height, ratio, anchor);
}

/** Exact numeric entry in output pixels; the top-left corner stays unless the size needs room. */
export function setCropGuidePixels(guide, field, value, width, height) {
    validSize(width, height);
    const number = Math.round(Number(value));
    if (!Number.isFinite(number)) return guide;
    const box = edges(guide, width, height);
    let w = Math.round(box.right - box.left), h = Math.round(box.bottom - box.top);
    let left = Math.round(box.left), top = Math.round(box.top);
    const min = minimumSize(width, height);
    const ratio = cropGuideLockedRatio(guide, width, height);
    if (field === "x") left = number;
    else if (field === "y") top = number;
    else if (field === "width") {
        w = clamp(number, min.w, width);
        if (ratio) ({ w, h } = sizeWithRatio(w, ratio, width, height, min));
    } else if (field === "height") {
        h = clamp(number, min.h, height);
        if (ratio) ({ w, h } = sizeWithRatio(h * ratio, ratio, width, height, min));
    } else {
        throw new RangeError(`Unknown crop guide field "${field}".`);
    }
    return fromBox(guide, { left, top, right: left + w, bottom: top + h }, width, height,
        field === "width" || field === "height" ? ratio : null);
}

export function centerCropGuide(guide, width, height) {
    validSize(width, height);
    const box = edges(guide, width, height);
    const w = box.right - box.left, h = box.bottom - box.top;
    const left = (width - w) / 2, top = (height - h) / 2;
    return fromBox(guide, { left, top, right: left + w, bottom: top + h }, width, height, null, { x: "center", y: "center" });
}

/** Largest centered rectangle of the locked ratio (the whole frame when Free is unlocked). */
export function fitCropGuide(guide, width, height) {
    validSize(width, height);
    const ratio = cropGuideLockedRatio(guide, width, height);
    let w = width, h = height;
    if (ratio) {
        if (width / height > ratio) w = height * ratio;
        else h = width / ratio;
    }
    const left = (width - w) / 2, top = (height - h) / 2;
    return fromBox(guide, { left, top, right: left + w, bottom: top + h }, width, height, ratio, { x: "center", y: "center" });
}

/** Switches the aspect preset; a fixed ratio reshapes the rectangle around its center with the same area. */
export function setCropGuideAspect(guide, key, width, height, customRatio = null) {
    validSize(width, height);
    if (!PRESET_KEYS.has(key)) throw new RangeError(`Unknown crop guide aspect "${key}".`);
    const next = { ...guide, aspect_ratio: key };
    if (Array.isArray(customRatio)) next.custom_aspect_ratio = normalizeCropGuide({ custom_aspect_ratio: customRatio }).custom_aspect_ratio;
    // Fixed presets always keep their ratio; choosing Free starts unlocked.
    next.aspect_ratio_locked = key !== "free";
    const ratio = cropGuidePresetRatio(next);
    if (!ratio) return next;
    const box = edges(guide, width, height);
    const area = (box.right - box.left) * (box.bottom - box.top);
    let w = Math.sqrt(area * ratio), h = w / ratio;
    const scale = Math.min(1, width / w, height / h);
    w *= scale; h *= scale;
    const cx = (box.left + box.right) / 2, cy = (box.top + box.bottom) / 2;
    const left = clamp(cx - w / 2, 0, width - w), top = clamp(cy - h / 2, 0, height - h);
    return fromBox(next, { left, top, right: left + w, bottom: top + h }, width, height, ratio, { x: "center", y: "center" });
}

/**
 * The crop_json record for one output image (mirrors build_crop_json in Python).
 * `rect` is normalized and enough to map the crop onto any resized copy of the image;
 * `pixel_rect` is the crop of this source image.
 */
export function buildCropJson(guide, width, height, poseIndex = 0) {
    const normalized = normalizeCropGuide(guide);
    const rect = { x: normalized.x, y: normalized.y, width: normalized.width, height: normalized.height };
    const ratio = cropGuidePresetRatio(normalized);
    const record = {
        schema_version: CROP_GUIDE_SCHEMA_VERSION,
        type: "vnccs_crop_guide",
        enabled: normalized.enabled,
        coordinate_system: "top_left_normalized",
        source: { width, height },
        rect,
        pixel_rect: cropGuidePixelRect(rect, width, height),
        aspect_ratio: normalized.aspect_ratio,
        aspect_ratio_value: ratio,
        aspect_ratio_locked: normalized.aspect_ratio_locked,
        pose_index: poseIndex,
    };
    if (normalized.aspect_ratio === "custom") record.custom_aspect_ratio = [...normalized.custom_aspect_ratio];
    return record;
}
