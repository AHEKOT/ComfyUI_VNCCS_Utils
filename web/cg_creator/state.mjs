export const MODEL_DEFAULTS = Object.freeze({ num_gaussians: 262144, steps: 20, guidance_scale: 3, seed: 0 });
export const DEFAULT_SETTINGS = Object.freeze({
    prompt: "Complete this rough 3D background render into a finished image. Preserve the camera angle, perspective, composition, geometry, and lighting. Reconstruct missing details and remove Gaussian splat artifacts. Do not add people or characters.",
    aspect: "16:9", resolution_mp: 2,
    generation: { steps: 25, cfg: 1, sampler: "euler", scheduler: "simple", seed: 0, turbo: false, prompt_enhance: true, cache_device: "gpu", cache_dtype: "int8", lora_stack: [] },
});
export const clone = value => JSON.parse(JSON.stringify(value));
export const settingsDefaults = (value = {}) => ({ ...clone(DEFAULT_SETTINGS), ...value, generation: { ...clone(DEFAULT_SETTINGS.generation), ...value.generation } });

export function readState(raw) {
    if (typeof raw !== "string" || raw.length > 256 * 1024) throw new Error("CG Creator state is too large.");
    const value = JSON.parse(raw);
    if (!value || Array.isArray(value) || value.schema_version !== 1) throw new Error("Unsupported CG Creator workflow state.");
    for (const key of ["background_id", "selected_image_id", "model_id", "selected_cg_id"]) {
        if (value[key] != null && (typeof value[key] !== "string" || (value[key] && !/^[a-f0-9]{32}$/.test(value[key])))) throw new Error("Invalid CG asset reference.");
    }
    if (value.camera != null && (!["position", "target", "up"].every(key => Array.isArray(value.camera[key]) && value.camera[key].length === 3 && value.camera[key].every(n => Number.isFinite(n) && Math.abs(n) <= 1e6))
        || !Number.isFinite(value.camera.fov) || value.camera.fov < 5 || value.camera.fov > 120)) throw new Error("Invalid saved CG camera.");
    if (value.frame != null && (![value.frame.width, value.frame.height].every(n => Number.isInteger(n) && n >= 64 && n <= 4096 && n % 16 === 0) || value.frame.width * value.frame.height > 16e6)) throw new Error("Invalid saved CG frame.");
    if (value.settings != null && (typeof value.settings !== "object" || Array.isArray(value.settings))) throw new Error("Invalid CG settings.");
    if (value.settings && Object.hasOwn(value.settings, "generation") && (!value.settings.generation || typeof value.settings.generation !== "object" || Array.isArray(value.settings.generation))) throw new Error("Invalid CG generation settings.");
    if (value.model_settings != null && (typeof value.model_settings !== "object" || Array.isArray(value.model_settings))) throw new Error("Invalid TripoSplat settings.");
    return { schema_version: 1, background_id: "", selected_image_id: "", model_id: "", selected_cg_id: "", ...value,
        settings: settingsDefaults(value.settings), model_settings: { ...MODEL_DEFAULTS, ...value.model_settings } };
}

export function sourceCameraView(source) {
    const camera = clone(source), scale = Math.tan(camera.fov * Math.PI / 360) / Math.tan(Math.PI / 6);
    camera.position = camera.position.map((value, i) => camera.target[i] + (value - camera.target[i]) * scale);
    camera.fov = 60;
    return camera;
}

export function frameDimensions(aspect, megapixels) {
    const [a, b] = String(aspect).split(":").map(Number), pixels = Number(megapixels) * 1e6;
    if (!(a > 0 && b > 0 && pixels > 0) || !Number.isFinite(pixels)) throw new Error("Invalid frame dimensions.");
    const width = Math.sqrt(pixels * a / b), height = Math.sqrt(pixels * b / a);
    const scale = Math.min(1, 4096 / Math.max(width, height), Math.sqrt(16e6 / pixels));
    const size = { width: Math.max(64, Math.round(width * scale / 16) * 16), height: Math.max(64, Math.round(height * scale / 16) * 16) };
    while (size.width * size.height > 16e6) size[size.width >= size.height ? "width" : "height"] -= 16;
    return size;
}
