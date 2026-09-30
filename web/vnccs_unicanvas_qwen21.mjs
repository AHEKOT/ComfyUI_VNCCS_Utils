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
    label: "QwenImage21",
    base: QWEN21_MODULE_KEY,
    isEditModel: true,
    detect: ["qwen-image-2.1", "qwen_image_2.1", "qwen-image-21", "qwen_image_21", "qwenimage21", "qi21"],
    defaults: {
      generation_mode: QWEN21_MODULE_KEY,
      model_loader: "diffusion_model",
      diffusion_model_name: "qwen_image_2.1_int8_convrot.safetensors",
      clip_name: "qwen3vl_8b_int8_convrot_bf16vision.safetensors",
      vae_name: "qwen_image_2.1_vae_bf16.safetensors",
      clip_type: "qwen_image",
      sampler_name: "euler",
      scheduler: "simple",
      // Viggle v0.2.1 turbo on by default: 6 steps at CFG 1.
      steps: 6,
      cfg: 1,
      denoise: 1,
      qwen21_turbo_enabled: true,
      qwen_lora_name: "viggle/Qwen-Image-2.1-viggle-turbo-v0.2.1-6step-lora-r128.safetensors",
      qwen_lora_strength: 1,
      qwen21_opaque_output: false,
      // AusBoss outpaint LoRA v2: applied in outpaint mode only (gray-padded canvas + fixed instruction).
      qwen21_outpaint_lora_name: "ausboss/qwen-image-2.1-outpaint-v2.safetensors",
      qwen21_outpaint_lora_strength: 1,
    },
  },
};

export function isQwen21Mode(mode) {
  return QWEN21_MODE_ALIASES.includes(String(mode || "").toLowerCase());
}

const QWEN21_HELP_TEXTS = {
  qwen21: "Qwen-Image-2.1 (QI2.1) generates with the official stack: 7B DiT + Qwen3-VL 8B text encoder + 64-channel RGBA image VAE. RGBA output is transparent by default.",
  transparent: "On: RGBA output with a transparent background (official RGBA prompting). Off: plain opaque image, flattened onto white.",
};

const QWEN21_PANEL_STYLE_ID = "vnccs-uc-qwen21-styles";

function ensureQwen21PanelStyles(doc = document) {
  if (!doc?.head || doc.getElementById(QWEN21_PANEL_STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = QWEN21_PANEL_STYLE_ID;
  style.textContent = `
.vnccs-uc-qwen21-panel { flex-direction:row; align-items:center; gap:6px; flex:0 0 auto; min-width:0; }
.vnccs-uc-qwen21-panel input[type="checkbox"] { margin-left:auto; accent-color:var(--uc-accent, #ff8fa3); }
.vnccs-uc-help { display:inline-flex; align-items:center; justify-content:center; width:14px; height:14px; flex:0 0 auto; border-radius:50%; border:1px solid var(--uc-border, rgba(255,255,255,.14)); color:var(--uc-muted, #9898a8); font-size:10px; cursor:help; }
`;
  doc.head.appendChild(style);
}

// Help "?" icon; the tooltip text is rendered by the shared body-level layer
// (vnccs_unicanvas_help.mjs), so the icon carries data-tip only (no native title).
function buildQwen21Help(key) {
  const help = document.createElement("span");
  help.className = "vnccs-uc-help";
  help.textContent = "?";
  help.dataset.tip = QWEN21_HELP_TEXTS[key] || "";
  return help;
}

// One "transparent output" switch (checked = RGBA/transparent = qwen21_opaque_output false).
function buildPanelShell() {
  ensureQwen21PanelStyles();
  const panel = document.createElement("label");
  panel.className = "vnccs-uc-field vnccs-uc-qwen21-panel";
  panel.dataset.qwen21Panel = "";
  panel.style.display = "none";
  panel.append("transparent output ", buildQwen21Help("transparent"));
  const input = document.createElement("input");
  input.type = "checkbox";
  input.dataset.qwen21Setting = "qwen21_opaque_output";
  panel.appendChild(input);
  return panel;
}

function refreshPanel(widget, panel) {
  const input = panel.querySelector("input[data-qwen21-setting]");
  if (input && widget?.settings) input.checked = !widget.settings.qwen21_opaque_output;
}

function bindPanelEvents(widget, panel) {
  panel.addEventListener("click", (event) => {
    // A "?" icon only shows its tooltip: it must not toggle the switch it sits next to.
    if (event.target instanceof HTMLElement && event.target.closest(".vnccs-uc-help")) event.preventDefault();
  });
  panel.addEventListener("input", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || !widget?.settings) return;
    widget.settings.qwen21_opaque_output = !target.checked;
    if (typeof widget.syncSettingsToWidget === "function") widget.syncSettingsToWidget();
  });
}

export function mountQwen21Panel(widget) {
  const host = widget?.container;
  if (!host || typeof host.querySelector !== "function") return null;
  let panel = host.querySelector("[data-qwen21-panel]");
  if (panel) return panel;
  // Right below the Steps field.
  const anchor = host.querySelector("[data-edit-steps-panel]");
  if (!anchor?.parentNode) return null;
  panel = buildPanelShell();
  anchor.parentNode.insertBefore(panel, anchor.nextSibling);
  bindPanelEvents(widget, panel);
  refreshPanel(widget, panel);
  return panel;
}

export function syncQwen21Panel(widget) {
  const panel = mountQwen21Panel(widget);
  if (!panel) return null;
  // The switch is exposed only for the Qwen-Image-2.1 family.
  const active = isQwen21Mode(widget && widget.settings ? widget.settings.generation_mode : "");
  panel.style.display = active ? "flex" : "none";
  if (active) refreshPanel(widget, panel);
  return panel;
}
