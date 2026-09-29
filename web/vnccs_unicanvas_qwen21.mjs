// Qwen-Image-2.1 family settings panel for VNCCS UniCanvas.
import { installCustomSelects } from "./vnccs_custom_select.mjs";

export const QWEN21_MODULE_KEY = "qwen_image21";

export const QWEN21_MODE_ALIASES = [
  "qwen_image21",
  "qwen-image-2.1",
  "qwen_image_21",
  "qwenimage21",
  "qi21",
  "qwen21",
];

// Native 2K aspect-ratio presets from the official Qwen-Image-2.1 table.
export const QWEN21_ASPECT_PRESETS = [
  "2048x2048",
  "2400x1792",
  "1792x2400",
  "2528x1696",
  "1696x2528",
  "2752x1536",
  "1536x2752",
];

export const UNICANVAS_QWEN21_MODULE = {
  [QWEN21_MODULE_KEY]: {
    key: QWEN21_MODULE_KEY,
    aliases: QWEN21_MODE_ALIASES.slice(1),
    label: "QwenImage21",
    base: QWEN21_MODULE_KEY,
    isEditModel: true,
    detect: ["qwen-image-2.1", "qwen_image_2.1", "qwen-image-21", "qwen_image_21", "qwenimage21", "qi21"],
    aspectPresets: QWEN21_ASPECT_PRESETS,
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
      qwen21_aspect_preset: "",
    },
  },
};

export function isQwen21Mode(mode) {
  return QWEN21_MODE_ALIASES.includes(String(mode || "").toLowerCase());
}

const QWEN21_HELP_TEXTS = {
  qwen21: "Qwen-Image-2.1 (QI2.1) generates with the official stack: 7B DiT + Qwen3-VL 8B text encoder + 64-channel RGBA image VAE. RGBA output is transparent by default.",
  opaque: "Disables the transparent-RGBA prompting and flattens the result - use it only when you want a plain opaque image.",
  aspect: "Forces one of the official 2K aspect presets; auto (match canvas) keeps the current canvas aspect ratio.",
};

const QWEN21_PANEL_STYLE_ID = "vnccs-uc-qwen21-styles";

// UniCanvas palette tokens (var(--uc-*) are defined on the widget root).
function ensureQwen21PanelStyles(doc = document) {
  if (!doc?.head || doc.getElementById(QWEN21_PANEL_STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = QWEN21_PANEL_STYLE_ID;
  style.textContent = `
.vnccs-uc-qwen21-panel { display:grid; gap:6px; padding:8px; background:var(--uc-panel, rgba(20,16,30,.82)); border:1px solid rgba(255,143,163,.2); border-radius:8px; color:var(--uc-text, #e8e8f0); font:11px var(--uc-font, sans-serif); }
.vnccs-uc-qwen21-title { display:flex; align-items:center; gap:6px; color:var(--uc-accent, #ff8fa3); font-weight:800; font-size:12px; letter-spacing:.02em; }
/* Accordion: the header line stays visible, the settings fold under it. */
.vnccs-uc-qwen21-expand { width:18px; height:18px; padding:0; border:0; background:transparent; color:inherit; cursor:pointer; font-size:11px; transition:transform .12s; }
.vnccs-uc-qwen21-expand[aria-expanded="true"] { transform:rotate(90deg); }
.vnccs-uc-qwen21-name { cursor:pointer; }
.vnccs-uc-qwen21-body { display:grid; gap:6px; }
.vnccs-uc-qwen21-body[hidden] { display:none; }
/* Never shrunk by the scrolling sidebar (it is a flex column): the panel keeps its full height. */
.vnccs-uc-qwen21-panel { flex:0 0 auto; min-width:0; box-sizing:border-box; }
.vnccs-uc-qwen21-panel .vnccs-uc-field { display:flex !important; flex-direction:row !important; flex-wrap:nowrap; align-items:center; justify-content:flex-start; gap:6px; text-align:left; min-width:0; }
.vnccs-uc-qwen21-panel .vnccs-uc-field .vnccs-uc-select, .vnccs-uc-qwen21-panel .vnccs-uc-field .vnccs-custom-select { flex:1 1 auto; min-width:0; width:auto; }
.vnccs-uc-qwen21-panel .vnccs-uc-field input[type="checkbox"] { margin-left:auto; }
.vnccs-uc-qwen21-panel input[type="checkbox"] { accent-color:var(--uc-accent, #ff8fa3); }
.vnccs-uc-help { display:inline-flex; align-items:center; justify-content:center; width:14px; height:14px; flex:0 0 auto; border-radius:50%; border:1px solid var(--uc-border, rgba(255,255,255,.14)); color:var(--uc-muted, #9898a8); font-size:10px; cursor:help; }
`;
  doc.head.appendChild(style);
}

// Help "?" icon with a hover tooltip explaining what a control is for. The tooltip
// text is rendered by the shared body-level layer (vnccs_unicanvas_help.mjs), so the
// icon carries data-tip only: a native title tooltip would double it up.
function buildQwen21Help(key) {
  const help = document.createElement("span");
  help.className = "vnccs-uc-help";
  help.textContent = "?";
  help.dataset.tip = QWEN21_HELP_TEXTS[key] || "";
  return help;
}

function buildPanelShell() {
  ensureQwen21PanelStyles();
  const panel = document.createElement("div");
  panel.className = "vnccs-uc-qwen21-panel";
  panel.dataset.qwen21Panel = "";
  panel.style.display = "none";

  // Accordion header: arrow, "QI2.1" and its help. The Turbo LoRA card is the shared one.
  const title = document.createElement("div");
  title.className = "vnccs-uc-qwen21-title";
  const qwenExpand = document.createElement("button");
  qwenExpand.type = "button";
  qwenExpand.className = "vnccs-uc-qwen21-expand";
  qwenExpand.dataset.qwen21Expand = "";
  qwenExpand.textContent = "▸";
  qwenExpand.title = "Show the Qwen-Image-2.1 settings";
  qwenExpand.setAttribute("aria-expanded", "false");
  const qwenTitleText = document.createElement("span");
  qwenTitleText.className = "vnccs-uc-qwen21-name";
  qwenTitleText.dataset.qwen21Expand = "";
  qwenTitleText.textContent = "QI2.1";
  qwenTitleText.title = "Qwen-Image-2.1 (QI2.1) settings";
  title.append(qwenExpand, qwenTitleText, buildQwen21Help("qwen21"));
  panel.appendChild(title);

  // Folded by default; the arrow (or the "QI2.1" name) unfolds it.
  const qwenBody = document.createElement("div");
  qwenBody.className = "vnccs-uc-qwen21-body";
  qwenBody.dataset.qwen21Body = "";
  qwenBody.hidden = true;
  panel.appendChild(qwenBody);

  const opaqueLabel = document.createElement("label");
  opaqueLabel.className = "vnccs-uc-field";
  opaqueLabel.textContent = "opaque output ";
  opaqueLabel.appendChild(buildQwen21Help("opaque"));
  const opaqueInput = document.createElement("input");
  opaqueInput.type = "checkbox";
  opaqueInput.dataset.qwen21Setting = "qwen21_opaque_output";
  opaqueLabel.appendChild(opaqueInput);
  qwenBody.appendChild(opaqueLabel);

  const aspectLabel = document.createElement("label");
  aspectLabel.className = "vnccs-uc-field";
  aspectLabel.textContent = "2K aspect preset ";
  aspectLabel.appendChild(buildQwen21Help("aspect"));
  const aspectSelect = document.createElement("select");
  aspectSelect.className = "vnccs-uc-select";
  aspectSelect.dataset.qwen21Setting = "qwen21_aspect_preset";
  const autoOption = document.createElement("option");
  autoOption.value = "";
  autoOption.textContent = "auto (match canvas)";
  aspectSelect.appendChild(autoOption);
  for (const preset of QWEN21_ASPECT_PRESETS) {
    const option = document.createElement("option");
    option.value = preset;
    option.textContent = preset;
    aspectSelect.appendChild(option);
  }
  aspectLabel.appendChild(aspectSelect);
  qwenBody.appendChild(aspectLabel);

  return panel;
}

function commitSettings(widget) {
  if (widget && typeof widget.syncSettingsToWidget === "function") widget.syncSettingsToWidget();
}

function refreshPanel(widget, panel) {
  if (!widget || !widget.settings) return;
  const opaque = panel.querySelector('[data-qwen21-setting="qwen21_opaque_output"]');
  if (opaque) opaque.checked = Boolean(widget.settings.qwen21_opaque_output);
  const aspect = panel.querySelector('[data-qwen21-setting="qwen21_aspect_preset"]');
  if (aspect) aspect.value = String(widget.settings.qwen21_aspect_preset || "");
}

function bindPanelEvents(widget, panel) {
  panel.addEventListener("input", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return;
    if (target.dataset.qwen21Setting === "qwen21_opaque_output") {
      widget.settings.qwen21_opaque_output = Boolean(target.checked);
    }
  });
  panel.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    // A "?" icon only shows its tooltip: it must not toggle the switch it sits next to.
    if (target.closest(".vnccs-uc-help")) {
      event.preventDefault();
      return;
    }
    if (target.dataset.qwen21Expand !== undefined) {
      const body = panel.querySelector("[data-qwen21-body]");
      const arrow = panel.querySelector("button[data-qwen21-expand]");
      if (!body) return;
      body.hidden = !body.hidden;
      arrow?.setAttribute("aria-expanded", String(!body.hidden));
    }
  });
  panel.addEventListener("change", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return;
    if (target.dataset.qwen21Setting === "qwen21_opaque_output") {
      widget.settings.qwen21_opaque_output = Boolean(target.checked);
    } else if (target.dataset.qwen21Setting === "qwen21_aspect_preset") {
      widget.settings.qwen21_aspect_preset = String(target.value || "");
    } else {
      return;
    }
    commitSettings(widget);
  });
}

export function mountQwen21Panel(widget) {
  const host = (widget && (widget.promptBox || widget.container)) || null;
  if (!host || typeof host.querySelector !== "function") return null;
  let panel = host.querySelector("[data-qwen21-panel]");
  if (panel) return panel;
  panel = buildPanelShell();
  const anchor = host.querySelector("[data-h3-panel]");
  if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(panel, anchor.nextSibling);
  else host.appendChild(panel);
  bindPanelEvents(widget, panel);
  refreshPanel(widget, panel);
  installCustomSelects(panel);
  return panel;
}

export function syncQwen21Panel(widget) {
  const panel = mountQwen21Panel(widget);
  if (!panel) return null;
  // The panel is exposed only for the Qwen-Image-2.1 family.
  const active = isQwen21Mode(widget && widget.settings ? widget.settings.generation_mode : "");
  panel.style.display = active ? "" : "none";
  if (active) refreshPanel(widget, panel);
  return panel;
}
