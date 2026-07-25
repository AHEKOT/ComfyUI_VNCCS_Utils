const PRESET_MODEL_ROLES = new Set(["checkpoint", "diffusion_model", "gguf"]);

export const UNICANVAS_PRESET_MODEL_SETTING_KEYS = Object.freeze([
  "generation_mode",
  "model_loader",
  "ckpt_name",
  "diffusion_model_name",
  "gguf_model_name",
  "clip_name",
  "vae_name",
  "clip_type",
]);

export function getUniCanvasPresetModelAsset(preset) {
  const assets = Array.isArray(preset?.assets) ? preset.assets : [];
  return assets.find((asset) => PRESET_MODEL_ROLES.has(String(asset?.role || "").toLowerCase())) || assets[0] || null;
}

export function getUniCanvasPresetModelName(preset) {
  const asset = getUniCanvasPresetModelAsset(preset);
  if (asset?.name) return String(asset.name);
  const settings = preset?.settings || {};
  const configuredName = settings.ckpt_name || settings.diffusion_model_name || settings.gguf_model_name || "";
  const fileName = String(configuredName).replace(/\\/g, "/").split("/").pop() || "";
  return fileName.replace(/\.(?:safetensors|gguf|ckpt|pt|pth|bin)$/i, "");
}

export function forceUniCanvasPresetModelSettings(settings, preset) {
  if (!settings || !preset?.settings) return settings;
  for (const key of UNICANVAS_PRESET_MODEL_SETTING_KEYS) {
    if (Object.prototype.hasOwnProperty.call(preset.settings, key)) settings[key] = preset.settings[key];
  }
  settings.model_selection_mode = "presets";
  settings.selected_preset_id = preset.id;
  return settings;
}
