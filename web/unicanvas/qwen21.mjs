// Qwen-Image-2.1 family settings panel for VNCCS UniCanvas.

export const QWEN21_MODULE_KEY = "qwen_image21";

export const QWEN21_MODE_ALIASES = [
  "qwen_image21",
  "qwen-image-2.1",
  "qwen_image_21",
  "qwenimage21",
  "qi21",
  "qwen21",
];

export const UNICANVAS_QWEN21_MODULE = {
  [QWEN21_MODULE_KEY]: {
    key: QWEN21_MODULE_KEY,
    aliases: QWEN21_MODE_ALIASES.slice(1),
    label: "Qwen Edit 2.1",
    base: QWEN21_MODULE_KEY,
    isEditModel: true,
    detect: ["qwen-image-2.1", "qwen_image_2.1", "qwen-image-21", "qwen_image_21", "qwenimage21", "qi21"],
    defaults: {
      generation_mode: QWEN21_MODULE_KEY,
      model_loader: "diffusion_model",
      diffusion_model_name: "qwen_image_2.1_int8_convrot.safetensors",
      clip_name: "qwen3vl_8b_int8_convrot.safetensors",
      vae_name: "qwen_image_2.1_vae_bf16.safetensors",
      clip_type: "qwen_image",
      sampler_name: "euler",
      scheduler: "simple",
      // Viggle v0.2.1 turbo on by default: 6 steps at CFG 1.
      steps: 6,
      cfg: 1,
      denoise: 1,
      qwen21_turbo_enabled: true,
      qwen_lora_name: "QI2/Viggle/Qwen-Image-2.1-viggle-turbo-v0.2.1-6step-lora-r128.safetensors",
      qwen_lora_strength: 1,
      // AusBoss outpaint LoRA v2: applied in outpaint mode only (gray-padded canvas + fixed instruction).
      qwen21_outpaint_lora_name: "ausboss/qwen-image-2.1-outpaint-v2.safetensors",
      qwen21_outpaint_lora_strength: 1,
    },
  },
};

export function isQwen21Mode(mode) {
  return QWEN21_MODE_ALIASES.includes(String(mode || "").toLowerCase());
}
