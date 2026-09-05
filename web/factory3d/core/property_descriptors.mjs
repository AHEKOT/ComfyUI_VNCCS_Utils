// These descriptors describe the current scene-11 light contract. Wider ranges
// and transform-v2 semantics require their own schema migration.
const numeric = (id, label, unit, hardMin, hardMax, step, extra = {}) => Object.freeze({
    id, label, valueType: "number", unit, hardMin, hardMax, step, defaultValue: Math.max(hardMin, 0),
    liveStrategy: "direct", ...extra,
});
const vectorProperties = (key, labels, unit, min, max, step, extra = {}) => Object.fromEntries(labels.map((label, index) => [
    `${key}.${index}`, numeric(`${key}.${index}`, label, unit, min, max, step, extra),
]));

export const LIGHT_NUMERIC_PROPERTIES = Object.freeze({
    ...Object.fromEntries(["X", "Y", "Z"].map((axis, index) => [
        `position.${index}`, numeric(`position.${index}`, axis, "m", -10000, 10000, 0.01),
    ])),
    intensity: numeric("intensity", "Strength", "", 0, 100000, 0.1, { defaultValue: 1, sliderMin: 0, sliderMax: 50 }),
    distance: numeric("distance", "Range", "m", 0, 1000000, 0.1, { sliderMin: 0, sliderMax: 100 }),
    ...vectorProperties("target", ["Target X", "Target Y", "Target Z"], "m", -10000, 10000, 0.01),
    angle: numeric("angle", "Cone half-angle", "deg", 1, 90, 0.1, { defaultValue: 45 }),
    penumbra: numeric("penumbra", "Soft edge", "", 0, 1, 0.01),
});

export const TRANSFORM_NUMERIC_PROPERTIES = Object.freeze({
    ...vectorProperties("position", ["X", "Y", "Z"], "m", -1000, 1000, 0.01),
    ...vectorProperties("rotation", ["X", "Y", "Z"], "deg", -180, 180, 0.01),
    scale: numeric("scale", "Scale", "", 0.001, 1000, 0.001, { defaultValue: 1 }),
});

export const PRIMITIVE_NUMERIC_PROPERTIES = Object.freeze({
    height_amplitude: numeric("height_amplitude", "Relief height", "m", 0, 10000, 0.01, { sliderMin: 0, sliderMax: 20 }),
    noise_frequency: numeric("noise_frequency", "Noise frequency", "", 0.00001, 100, 0.001, { defaultValue: 0.1, sliderMin: 0.001, sliderMax: 1 }),
    noise_seed: numeric("noise_seed", "Seed", "", 0, 2147483647, 1, { defaultValue: 1, integer: true, sliderMin: 0, sliderMax: 1000 }),
    noise_octaves: numeric("noise_octaves", "Detail octaves", "", 1, 8, 1, { defaultValue: 4, integer: true }),
    ...Object.fromEntries(["width", "height", "depth"].map(key => [key,
        numeric(key, key[0].toUpperCase() + key.slice(1), "m", 0.001, 100000, 0.01, { defaultValue: 2, sliderMin: 0.01, sliderMax: 20 })])),
    extrusion: numeric("extrusion", "Extrusion", "m", 0, 100000, 0.01, { sliderMin: 0, sliderMax: 5 }),
    steps: numeric("steps", "Step count", "", 1, 256, 1, { defaultValue: 12, integer: true, sliderMin: 1, sliderMax: 32 }),
    radial_segments: numeric("radial_segments", "Radial segments", "", 8, 128, 1, { defaultValue: 32, integer: true }),
    ...vectorProperties("segments", ["Segments X", "Segments Z"], "", 1, 128, 1, { integer: true }),
    ...vectorProperties("uv_scale", ["Texture scale X", "Texture scale Y"], "", 0.001, 1000, 0.01, { defaultValue: 1, sliderMin: 0.01, sliderMax: 20 }),
    ...vectorProperties("uv_offset", ["Texture offset X", "Texture offset Y"], "", -1000, 1000, 0.01, { sliderMin: -2, sliderMax: 2 }),
    uv_rotation: numeric("uv_rotation", "Texture rotation", "deg", -36000, 36000, 0.1, { sliderMin: -180, sliderMax: 180 }),
    opacity: numeric("opacity", "Opacity", "", 0, 1, 0.01, { defaultValue: 1 }),
});
export const MODEL_NUMERIC_PROPERTIES = Object.freeze({
    ...TRANSFORM_NUMERIC_PROPERTIES,
    ...Object.fromEntries(Object.entries(PRIMITIVE_NUMERIC_PROPERTIES).map(([path, descriptor]) => [
        `primitive.${path}`, Object.freeze({ ...descriptor, id: `primitive.${path}` }),
    ])),
});

export const CAMERA_NUMERIC_PROPERTIES = Object.freeze({
    ...vectorProperties("position", ["X", "Y", "Z"], "m", -10000, 10000, 0.01),
    ...vectorProperties("rotation", ["Pitch X", "Yaw Y", "Roll Z"], "deg", -36000, 36000, 0.01, { sliderMin: -180, sliderMax: 180 }),
    fov: numeric("fov", "FOV", "deg", 5, 120, 0.01, { defaultValue: 45 }),
    focus_distance: numeric("focus_distance", "Target distance", "m", 0.001, 100000, 0.001, { defaultValue: 5, sliderMin: 0.001, sliderMax: 50 }),
});

export const WALL_NUMERIC_PROPERTIES = Object.freeze({
    height: numeric("height", "Height", "m", 0.05, 1000, 0.01, { defaultValue: 2.8, sliderMin: 0.05, sliderMax: 10 }),
    thickness: numeric("thickness", "Thickness", "m", 0.01, 10, 0.01, { defaultValue: 0.12, sliderMin: 0.01, sliderMax: 1 }),
    elevation_offset: numeric("elevation_offset", "Base offset", "m", -10000, 10000, 0.01),
});

export function readLightProperty(light, path) {
    return readNumericProperty(light, path, LIGHT_NUMERIC_PROPERTIES);
}

export function readNumericProperty(target, path, descriptors) {
    if (!Object.hasOwn(descriptors, path)) throw new Error("Unsupported numeric property");
    const [key, index] = path.split(".");
    return index === undefined ? target[key] : target[key][Number(index)];
}

export function writeLightProperty(light, path, value) {
    return writeNumericProperty(light, path, value, LIGHT_NUMERIC_PROPERTIES);
}

export function writeNumericProperty(target, path, value, descriptors) {
    if (!Object.hasOwn(descriptors, path)) throw new Error("Unsupported numeric property");
    if (!Number.isFinite(value)) throw new Error("Property must be finite");
    const [key, index] = path.split(".");
    if (index === undefined) target[key] = value;
    else target[key][Number(index)] = value;
}

/** Parse a numeric draft without coercing an unfinished input to zero. */
export function acceptNumericDraft(descriptor, draft, baseValue = 0) {
    const text = String(draft ?? "").trim();
    const match = /^([+*/-]=)?\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*(m|cm|mm|km|deg|°|rad)?$/i.exec(text);
    if (!match) {
        return { valid: false, message: "Enter a finite number; Escape cancels this edit." };
    }
    const [, operation, raw, suffix] = match;
    const units = descriptor.unit === "m" ? { m: 1, cm: 0.01, mm: 0.001, km: 1000 }
        : descriptor.unit === "deg" ? { deg: 1, "°": 1, rad: 180 / Math.PI } : {};
    if (suffix && (!Object.hasOwn(units, suffix.toLowerCase()) || ["*=", "/="].includes(operation))) {
        return { valid: false, message: "This unit is not supported for this property or operation." };
    }
    const operand = Number(raw) * (suffix ? units[suffix.toLowerCase()] : 1);
    const requested = operation === "+=" ? baseValue + operand : operation === "-=" ? baseValue - operand
        : operation === "*=" ? baseValue * operand : operation === "/=" ? baseValue / operand : operand;
    if (!Number.isFinite(requested)) return { valid: false, message: "Enter a finite number." };
    const bounded = Math.max(descriptor.hardMin, Math.min(descriptor.hardMax, requested));
    const value = descriptor.integer ? Math.trunc(bounded) : bounded;
    return { valid: true, value, message: value === requested ? "" : `Limited to ${value}${descriptor.unit ? ` ${descriptor.unit}` : ""}.` };
}
