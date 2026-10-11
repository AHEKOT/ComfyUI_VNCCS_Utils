/**
 * VNCCS UniCanvas - Remove background settings (gear popover) and request shaping.
 *
 * Backends: Edit model (RGBA-VAE edit families: Qwen Image 2.1; MiniMax H3 decodes RGB only,
 * so it cannot remove a background), BiRefNet,
 * rembg (ONNX, downloaded on first use) and SAM 3 (interactive keep points through the SAM
 * tool). The Edit model backend runs a full generation, so it gets its own loader, model
 * files, steps, cfg, sampler, scheduler and an optional (turbo) LoRA at strength 1, stored per family in
 * settings.remove_bg_edit[family].
 * The seed is not user-facing: the backend draws a fresh one for every run.
 */

export const REMOVE_BG_METHODS = [
  ["edit", "Edit model"],
  ["birefnet", "BiRefNet"],
  ["rembg", "rembg"],
  ["sam3", "SAM 3 (pick what to keep)"],
];
export const REMOVE_BG_EDIT_MODES = [
  ["qwen_image21", "Qwen Edit 2.1"],
];
// The universal instruction sent for every Remove bg run (editable in the settings).
export const REMOVE_BG_DEFAULT_PROMPT = "Remove the background, and output a PNG image";
// Viggle v0.2.1 turbo: Remove bg runs it by default at 6 steps (about 9 s on a 4090).
const REMOVE_BG_TURBO_LORA = "Qwen-Image-2.1-viggle-turbo-v0.2.1-6step-lora-r128.safetensors";
const REMOVE_BG_TURBO_STEPS = 6;
const EDIT_LOADERS = [
  ["diffusion_model", "Diffusion Model"],
  ["gguf", "GGUF"],
];
// Keys the backend accepts for an edit-model run (see nodes/unicanvas/remove_bg.py).
export const REMOVE_BG_EDIT_KEYS = [
  "model_loader", "diffusion_model_name", "gguf_model_name", "gguf_arch",
  "clip_name", "vae_name", "steps", "cfg", "sampler_name", "scheduler", "lora_name", "prompt",
];

export function resolveRemoveBgSelection(settings) {
  const source = settings || {};
  const raw = String(source.remove_bg_model || "birefnet");
  const method = raw === "qi21" ? "edit" : raw;
  const editModel = REMOVE_BG_EDIT_MODES.some(([key]) => key === source.remove_bg_edit_model)
    ? source.remove_bg_edit_model
    : REMOVE_BG_EDIT_MODES[0][0];
  return { method, editModel };
}

/** Only what the user set for this family; the backend fills the rest from the family defaults. */
export function removeBgEditSettings(settings, editModel) {
  const stored = settings?.remove_bg_edit?.[editModel];
  if (!stored || typeof stored !== "object") return {};
  // lora_name is sent even when empty: an explicit "None" turns the family turbo LoRA off.
  return Object.fromEntries(REMOVE_BG_EDIT_KEYS
    .filter((key) => stored[key] !== undefined && (stored[key] !== "" || key === "lora_name"))
    .map((key) => [key, stored[key]]));
}

/**
 * Builds the Remove background rows of the settings popover.
 * `ui` = { bind(label, control) -> row, makeSelect(pairs, value), commit(), assets, familyDefaults(mode) }.
 */
export function buildRemoveBgSettings(settings, ui) {
  const { bind, makeSelect, commit, assets, familyDefaults } = ui;
  const selection = resolveRemoveBgSelection(settings);
  const method = makeSelect(REMOVE_BG_METHODS, selection.method);
  bind("Remove background", method);

  const editRows = [];
  const editRow = (label, control) => {
    const row = bind(label, control);
    editRows.push(row);
    return row;
  };
  const mode = makeSelect(REMOVE_BG_EDIT_MODES, selection.editModel);
  const modeRow = editRow("Mode", mode);

  const stored = () => {
    settings.remove_bg_edit ||= {};
    return (settings.remove_bg_edit[mode.value] ||= {});
  };
  // Effective value: user's pick, then the family default (matched by file name, so a default
  // without a subfolder finds "qwen/<file>"), then the first installed asset.
  const baseName = (value) => String(value || "").replaceAll("\\", "/").split("/").pop().toLowerCase();
  const effective = (key, list = null) => {
    const own = stored()[key];
    if (own !== undefined && own !== "") return own;
    const fallback = familyDefaults(mode.value)?.[key];
    if (fallback !== undefined && fallback !== "") {
      if (!list || list.includes(fallback)) return fallback;
      const match = list.find((name) => baseName(name) === baseName(fallback));
      if (match) return match;
    }
    return list?.[0] ?? fallback ?? "";
  };
  // The files shown are the files that run: pin them into the stored settings.
  const pin = (key, value) => {
    if (value && stored()[key] === undefined) stored()[key] = value;
  };
  const withCurrent = (list, value) => (value && !list.includes(value) ? [value, ...list] : list)
    .map((name) => [name, name || "None"]);

  const loader = makeSelect(EDIT_LOADERS, "diffusion_model");
  const diffusionModel = makeSelect([], "");
  const ggufModel = makeSelect([], "");
  const ggufArch = makeSelect([], "");
  const clip = makeSelect([], "");
  const vae = makeSelect([], "");
  const steps = numberInput(1, 200, 1);
  const cfg = numberInput(0, 30, 0.1);
  const sampler = makeSelect([], "");
  const scheduler = makeSelect([], "");
  const lora = makeSelect([], "");
  const prompt = document.createElement("textarea");
  prompt.className = "vnccs-uc-textarea";
  prompt.rows = 3;
  prompt.placeholder = REMOVE_BG_DEFAULT_PROMPT;
  // Loader, Steps and CFG are short: one row.
  const compact = document.createElement("div");
  compact.className = "vnccs-uc-settings-inline";
  compact.style.cssText = "display:grid; grid-template-columns:minmax(0,2fr) minmax(0,1fr) minmax(0,1fr); gap:6px;";
  const loaderRow = editRow("Loader", loader);
  loaderRow.before(compact);
  compact.append(loaderRow, editRow("Steps", steps), editRow("CFG", cfg));
  editRows.push(compact);
  const diffusionRow = editRow("Diffusion model", diffusionModel);
  const ggufRow = editRow("GGUF model", ggufModel);
  const archRow = editRow("GGUF architecture", ggufArch);
  editRow("CLIP", clip);
  editRow("VAE", vae);
  editRow("Sampler", sampler);
  editRow("Scheduler", scheduler);
  editRow("Turbo LoRA (optional)", lora);
  editRow("Remove bg prompt (sent on every run)", prompt);

  const fill = (select, list, value) => {
    select.replaceChildren(...withCurrent(list, value).map(([optionValue, label]) => {
      const option = document.createElement("option");
      option.value = optionValue;
      option.textContent = label;
      return option;
    }));
    select.value = value;
  };
  // Rows are grid labels (label above control): show them with "grid", never "".
  const show = (row, visible) => { row.style.display = visible ? "grid" : "none"; };
  const render = () => {
    const isEdit = method.value === "edit";
    for (const row of editRows) show(row, isEdit);
    if (!isEdit) return;
    show(modeRow, REMOVE_BG_EDIT_MODES.length > 1);
    loader.value = effective("model_loader") === "gguf" ? "gguf" : "diffusion_model";
    const gguf = loader.value === "gguf";
    show(diffusionRow, !gguf);
    show(ggufRow, gguf);
    show(archRow, gguf);
    const fileValues = {
      model_loader: loader.value,
      diffusion_model_name: effective("diffusion_model_name", assets.diffusion_models),
      gguf_model_name: effective("gguf_model_name", assets.gguf_models),
      clip_name: effective("clip_name", assets.text_encoders),
      vae_name: effective("vae_name", assets.vae_models),
    };
    fill(diffusionModel, assets.diffusion_models || [], fileValues.diffusion_model_name);
    fill(ggufModel, assets.gguf_models || [], fileValues.gguf_model_name);
    fill(ggufArch, assets.gguf_architectures || ["auto"], effective("gguf_arch", assets.gguf_architectures) || "auto");
    fill(clip, assets.text_encoders || [], fileValues.clip_name);
    fill(vae, assets.vae_models || [], fileValues.vae_name);
    const before = JSON.stringify(stored());
    for (const [key, value] of Object.entries(fileValues)) pin(key, value);
    if (JSON.stringify(stored()) !== before) commit();
    fill(sampler, assets.samplers || [], effective("sampler_name", assets.samplers));
    fill(scheduler, assets.schedulers || [], effective("scheduler", assets.schedulers));
    // Turbo LoRA by default (the installed Viggle v0.2.1 file, any subfolder); "None" disables it.
    const loras = assets.loras || [];
    if (stored().lora_name === undefined) {
      const turbo = loras.find((name) => baseName(name) === REMOVE_BG_TURBO_LORA.toLowerCase());
      if (turbo) {
        stored().lora_name = turbo;
        if (stored().steps === undefined) stored().steps = REMOVE_BG_TURBO_STEPS;
      }
    }
    const loraName = stored().lora_name || "";
    fill(lora, ["", ...loras], loraName);
    steps.value = String(effective("steps") || REMOVE_BG_TURBO_STEPS);
    cfg.value = String(effective("cfg") ?? 1);
    prompt.value = stored().prompt ?? REMOVE_BG_DEFAULT_PROMPT;
  };
  const store = (key, value) => {
    stored()[key] = value;
    commit();
  };

  method.addEventListener("input", () => { settings.remove_bg_model = method.value; render(); commit(); });
  mode.addEventListener("input", () => { settings.remove_bg_edit_model = mode.value; render(); commit(); });
  loader.addEventListener("input", () => { store("model_loader", loader.value); render(); });
  diffusionModel.addEventListener("input", () => store("diffusion_model_name", diffusionModel.value));
  ggufModel.addEventListener("input", () => store("gguf_model_name", ggufModel.value));
  ggufArch.addEventListener("input", () => store("gguf_arch", ggufArch.value));
  clip.addEventListener("input", () => store("clip_name", clip.value));
  vae.addEventListener("input", () => store("vae_name", vae.value));
  sampler.addEventListener("input", () => store("sampler_name", sampler.value));
  scheduler.addEventListener("input", () => store("scheduler", scheduler.value));
  lora.addEventListener("input", () => { store("lora_name", lora.value); render(); });
  prompt.addEventListener("input", () => store("prompt", prompt.value));
  steps.addEventListener("input", () => {
    const value = Math.round(Number(steps.value));
    if (value >= 1 && value <= 200) store("steps", value);
  });
  cfg.addEventListener("input", () => {
    const value = Number(cfg.value);
    if (Number.isFinite(value) && value >= 0 && value <= 30) store("cfg", value);
  });
  render();
  return { render };
}

function numberInput(min, max, step) {
  const input = document.createElement("input");
  input.className = "vnccs-uc-input";
  input.type = "number";
  input.lang = "en-US";
  input.inputMode = "decimal";
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  return input;
}
