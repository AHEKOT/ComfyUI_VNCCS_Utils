/**
 * VNCCS UniCanvas - prompt enhance (the magic wand in the Prompt / Negative boxes).
 *
 * The wand rewrites the box with the model family's own text encoder (POST
 * /vnccs/unicanvas/enhance_prompt) using the system prompt stored for that family. The system
 * prompts are defaults from config/prompt_enhance/ that the user can edit or extend in the
 * ComfyUI settings (VNCCS > UniCanvas > Prompt enhance) - global for the extension, one entry per
 * model family. With "automatic" on, the same rewrite runs on the backend right before every
 * generation instead (the draw payload carries `prompt_enhance`).
 *
 * Nothing here applies while a VNCSS Config is linked: a custom model stack has no family
 * system prompt, so the wand is hidden and no enhance setting reaches the draw.
 */

export const ENHANCE_PROMPTS_ID = "VNCCS.UniCanvas.PromptEnhance.Prompts";
// Node-level switches (UniCanvas settings popover); they never reach a draw, only `prompt_enhance` does.
export const ENHANCE_ENABLED = "prompt_enhance_enabled";
export const ENHANCE_AUTO = "prompt_enhance_auto";
export const ENHANCE_MODEL = "prompt_enhance_model";
const NODE_KEYS = [ENHANCE_ENABLED, ENHANCE_AUTO, ENHANCE_MODEL];
// The Qwen3-VL encoder Qwen-Image-2.1 uses; the backend downloads it from Hugging Face on first use.
export const DEFAULT_ENHANCE_MODEL = "qwen3vl_8b_int8_convrot.safetensors";
const MAX_IMAGE_SIDE = 1536; // upload size only; the backend fits its own pixel budget

export const PROMPT_ENHANCE_CSS = `
.vnccs-uc-enhance-wrap { position:relative; display:block; }
.vnccs-uc-enhance-wrap.has-enhance > .vnccs-uc-textarea { padding-right:30px; }
/* The wand is a bare outline icon (a button only for the keyboard): no frame, no fill. */
.vnccs-uc-enhance-btn { position:absolute; top:6px; right:7px; width:18px; height:18px; padding:0; margin:0; display:grid; place-items:center; border:0; background:none; color:var(--uc-muted); opacity:.75; cursor:pointer; transition:color .15s ease, opacity .15s ease, transform .15s ease; }
.vnccs-uc-enhance-btn svg { width:18px; height:18px; overflow:visible; }
.vnccs-uc-enhance-btn[hidden] { display:none; }
.vnccs-uc-enhance-btn:hover, .vnccs-uc-enhance-btn:focus-visible { color:var(--uc-accent); opacity:1; transform:rotate(-12deg) scale(1.08); outline:none; }
.vnccs-uc-enhance-btn .vnccs-uc-wand-ink { stroke:currentColor; }
.vnccs-uc-enhance-btn.working { opacity:1; cursor:progress; transform:none; filter:drop-shadow(0 0 3px rgba(255,143,163,.55)); animation:vnccs-uc-enhance-glow 1.4s ease-in-out infinite; }
.vnccs-uc-enhance-btn.working .vnccs-uc-wand-ink { stroke:var(--vnccs-wand-gradient); }
.vnccs-uc-enhance-btn.error { color:#ff6b6b; opacity:1; }
.vnccs-uc-enhance-btn.done { animation:vnccs-uc-enhance-pop .55s cubic-bezier(.2,1.4,.4,1); }
.vnccs-uc-enhance-spark { position:absolute; pointer-events:none; z-index:5; }
.vnccs-uc-enhance-spark.star { clip-path:polygon(50% 0, 62% 38%, 100% 50%, 62% 62%, 50% 100%, 38% 62%, 0 50%, 38% 38%); }
.vnccs-uc-enhance-spark.dot { border-radius:50%; }
@keyframes vnccs-uc-enhance-glow { 0%,100% { filter:drop-shadow(0 0 2px rgba(255,143,163,.4)); } 50% { filter:drop-shadow(0 0 6px rgba(184,169,232,.85)); } }
@keyframes vnccs-uc-enhance-pop { 0% { transform:scale(1); } 35% { transform:scale(1.45) rotate(-14deg); } 100% { transform:scale(1); } }
@media (prefers-reduced-motion: reduce) { .vnccs-uc-enhance-btn.working, .vnccs-uc-enhance-btn.done { animation:none; } }
`;

// The system-prompt dialog is opened from the ComfyUI settings, outside .vnccs-unicanvas, so it brings its own styles.
const DIALOG_CSS = `
/* Same tokens and shapes as the UniCanvas widget (panels, section heads, .vnccs-uc-btn, inputs). */
/* z-index above the standalone shell (2147481000) and the fullscreen portal (2147482000) of UniCanvas. */
.vnccs-pe-overlay { position:fixed; inset:0; z-index:2147483000; display:grid; place-items:center; background:rgba(4,4,8,.58); }
.vnccs-pe-dialog { --uc-bg:#0a0a0f; --uc-panel:rgba(20,16,30,.96); --uc-surface:rgba(30,28,44,.9); --uc-hover:rgba(44,40,62,.95); --uc-border:rgba(255,255,255,.08);
  --uc-accent:#ff8fa3; --uc-accent-2:#b8a9e8; --uc-text:#e8e8f0; --uc-muted:#9898a8; --uc-good:#00d68f;
  width:min(1040px,94vw); height:min(780px,90vh); display:grid; grid-template-rows:auto 1fr auto; background:var(--uc-panel); color:var(--uc-text); border:1px solid rgba(255,143,163,.34); border-radius:12px; box-shadow:0 18px 48px rgba(0,0,0,.55); overflow:hidden; font:12px 'Sora',-apple-system,BlinkMacSystemFont,sans-serif; }
.vnccs-pe-head { display:flex; align-items:center; gap:12px; padding:14px 18px; border-bottom:1px solid var(--uc-border); }
.vnccs-pe-head h2 { margin:0; font-size:18px; font-weight:800; color:var(--uc-accent); }
.vnccs-pe-head p { margin:0; color:var(--uc-muted); flex:1; }
.vnccs-pe-body { display:grid; grid-template-columns:230px 1fr; gap:8px; padding:8px; min-height:0; background:rgba(6,5,12,.72); }
.vnccs-pe-tabs, .vnccs-pe-pane { background:var(--uc-panel); border:1px solid rgba(255,143,163,.2); border-radius:12px; box-shadow:0 4px 16px rgba(0,0,0,.35); min-height:0; }
.vnccs-pe-tabs { display:flex; flex-direction:column; gap:3px; padding:8px; overflow:auto; }
.vnccs-pe-tab { display:flex; align-items:center; gap:8px; width:100%; height:32px; padding:0 9px; border:1px solid transparent; border-radius:8px; background:none; color:var(--uc-muted); font:inherit; text-align:left; cursor:pointer; flex:0 0 auto; }
.vnccs-pe-tab:hover { background:var(--uc-hover); color:var(--uc-text); }
.vnccs-pe-tab[aria-selected="true"] { border-color:rgba(255,143,163,.7); background:rgba(255,143,163,.18); color:#ffdce5; font-weight:700; }
.vnccs-pe-tab:focus-visible { outline:2px solid var(--uc-accent); outline-offset:-2px; }
.vnccs-pe-dot { flex:0 0 auto; width:8px; height:8px; border-radius:50%; border:1.5px solid var(--uc-muted); }
.vnccs-pe-tab.on .vnccs-pe-dot { background:var(--uc-good); border-color:transparent; }
.vnccs-pe-pane { display:grid; grid-template-rows:auto 1fr auto; padding:12px; gap:10px; overflow:auto; }
.vnccs-pe-title { display:flex; align-items:baseline; gap:10px; }
.vnccs-pe-title h3 { margin:0; font-size:15px; font-weight:800; color:var(--uc-accent); }
.vnccs-pe-title span { color:var(--uc-muted); }
.vnccs-pe-fields { display:grid; grid-template-rows:repeat(3,minmax(120px,1fr)); gap:8px; min-height:0; }
.vnccs-pe-field { display:grid; grid-template-rows:auto 1fr; min-height:0; border:1px solid rgba(255,255,255,.1); border-radius:8px; background:rgba(255,255,255,.03); overflow:hidden; }
.vnccs-pe-field label { display:flex; justify-content:space-between; gap:10px; padding:7px 10px; font-weight:700; color:var(--uc-accent); border-bottom:1px solid var(--uc-border); }
.vnccs-pe-field label small { font-weight:400; color:var(--uc-muted); }
.vnccs-pe-field textarea { width:100%; height:100%; box-sizing:border-box; resize:none; padding:8px 10px; border:0; background:rgba(255,255,255,.045); color:var(--uc-text); font:12px/1.45 ui-monospace,Consolas,monospace; color-scheme:dark; }
.vnccs-pe-field textarea:focus { outline:none; box-shadow:inset 0 0 0 2px rgba(255,143,163,.45); }
.vnccs-pe-actions, .vnccs-pe-foot { display:flex; gap:8px; align-items:center; }
.vnccs-pe-foot { padding:10px 18px; border-top:1px solid var(--uc-border); justify-content:space-between; color:var(--uc-muted); }
.vnccs-pe-btn { height:28px; padding:0 9px; border-radius:8px; border:1px solid var(--uc-border); background:var(--uc-surface); color:var(--uc-text); font:inherit; white-space:nowrap; cursor:pointer; }
.vnccs-pe-btn:hover:not(:disabled) { background:var(--uc-hover); border-color:rgba(255,255,255,.16); }
.vnccs-pe-btn:disabled { opacity:.38; cursor:not-allowed; }
.vnccs-pe-btn.primary { height:34px; padding:0 14px; border:0; background:linear-gradient(135deg,var(--uc-accent),var(--uc-accent-2)); color:#120b13; font-weight:800; }
.vnccs-pe-status { margin-left:auto; }
.vnccs-pe-status.on { color:var(--uc-good); }
@media (max-width:760px) { .vnccs-pe-body { grid-template-columns:1fr; grid-template-rows:auto 1fr; } .vnccs-pe-tabs { flex-direction:row; } .vnccs-pe-tab { width:auto; white-space:nowrap; } }
`;

let wandCount = 0;

/**
 * The outline wand. While it works its stroke switches to a gradient that flows along the icon
 * (SMIL translate on a repeating userSpace gradient, started and stopped with the work).
 */
export function wandSvg() {
  const id = `vnccs-wand-gradient-${wandCount += 1}`;
  return `<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="--vnccs-wand-gradient:url(#${id})">
<defs><linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="16" y2="0" spreadMethod="repeat">
<stop offset="0" stop-color="#ff8fa3"/><stop offset=".5" stop-color="#b8a9e8"/><stop offset="1" stop-color="#ff8fa3"/>
<animateTransform attributeName="gradientTransform" type="translate" from="0 0" to="16 0" dur="0.9s" repeatCount="indefinite" begin="indefinite"/>
</linearGradient></defs>
<g class="vnccs-uc-wand-ink"><path d="M4 20 14 10"/><path d="m16 3 1.1 2.4L19.5 6.5 17.1 7.6 16 10l-1.1-2.4L12.5 6.5l2.4-1.1z"/><path d="M19 13v3M17.5 14.5h3M6 4v2M5 5h2"/></g></svg>`;
}

function flowGradient(button, running) {
  const animation = button.querySelector("animateTransform");
  try { running ? animation?.beginElement() : animation?.endElement(); } catch (_) { /* SMIL unavailable: the gradient just stays still */ }
}

// Where the values come from: the ComfyUI settings store, bound by the widget module.
let readSetting = () => undefined;
let writeSetting = () => {};
export function bindEnhanceSettingsReader(reader, writer = () => {}) {
  readSetting = reader;
  writeSetting = writer;
}

let defaultEntries = null;
let defaultsRequest = null;
const widgets = new Set(); // WeakRef<widget>

/** Default system prompts (config/prompt_enhance/) - fetched once, [] until they arrive. */
export function loadEnhanceDefaults() {
  defaultsRequest ||= fetch("/vnccs/unicanvas/prompt_enhance_defaults", { cache: "no-store" })
    .then((res) => (res.ok ? res.json() : { entries: [] }))
    .then((data) => { defaultEntries = Array.isArray(data.entries) ? data.entries : []; return defaultEntries; })
    .catch(() => { defaultsRequest = null; return []; });
  return defaultsRequest;
}

/** One entry per family (the first wins), so a stored list can never hold a duplicate. */
export function uniqueByFamily(entries) {
  const seen = new Set();
  return entries.filter((entry) => entry && entry.family && !seen.has(entry.family) && seen.add(entry.family));
}

/** The shipped defaults, each family replaced by the user's saved entry when there is one (even a blank one). */
export function mergeEntries(defaults, stored) {
  const saved = new Map(uniqueByFamily(Array.isArray(stored) ? stored : []).map((entry) => [entry.family, entry]));
  const merged = uniqueByFamily(defaults).map((entry) => saved.get(entry.family) || entry);
  const known = new Set(merged.map((entry) => entry.family));
  return [...merged, ...[...saved.values()].filter((entry) => !known.has(entry.family))];
}

/** Effective entries: the defaults with the user's changes on top. */
export function enhanceEntries() {
  return mergeEntries(defaultEntries || [], readSetting(ENHANCE_PROMPTS_ID));
}

const text = (value) => String(value ?? "").trim();
const enhanceEnabled = (widget) => widget.settings[ENHANCE_ENABLED] !== false;
const enhanceAuto = (widget) => widget.settings[ENHANCE_AUTO] === true;
/** The encoder the wand uses (automatic mode always uses the family's own). */
export const enhanceModel = (widget) => text(widget.settings[ENHANCE_MODEL]) || DEFAULT_ENHANCE_MODEL;

/** The entry the wand uses for the current family, or null (disabled, config linked, none written). */
export function activeEnhanceEntry(widget) {
  if (!enhanceEnabled(widget) || widget._isConfigLinked()) return null;
  const family = widget.getModelKey();
  return enhanceEntries().find((entry) => entry.family === family && (text(entry.positive) || text(entry.edit))) || null;
}

function systemFor(entry, kind, hasImage) {
  if (kind === "negative") return text(entry.negative);
  return hasImage ? (text(entry.edit) || text(entry.positive)) : (text(entry.positive) || text(entry.edit));
}

/** Show or hide the wands for the current family and mark them while automatic mode is on. */
export function syncPromptEnhance(widget) {
  const entry = activeEnhanceEntry(widget);
  const auto = Boolean(entry) && enhanceAuto(widget);
  widget.container.querySelectorAll("[data-enhance]").forEach((button) => {
    const kind = button.dataset.enhance;
    // The wand is pointless in automatic mode: both prompts are enhanced on Generate.
    const available = Boolean(entry) && !auto && (kind !== "negative" || (Boolean(text(entry.negative)) && widget.modelUsesNegative()));
    button.hidden = !available;
    button.title = "Enhance Prompt";
    button.parentElement?.classList.toggle("has-enhance", available);
  });
}

/** Re-sync every open widget after a setting changed. */
export function refreshAllPromptEnhance() {
  for (const ref of [...widgets]) {
    const widget = ref.deref();
    if (!widget) widgets.delete(ref);
    else if (!widget._disposed) syncPromptEnhance(widget);
  }
}

/** Drops the node-level enhance switches from a payload copy. */
export function stripEnhanceSettings(settings) {
  for (const key of NODE_KEYS) delete settings[key];
  return settings;
}

/** `prompt_enhance` for the draw payload: only with automatic mode on and a usable entry. */
export function promptEnhancePayload(widget) {
  const entry = activeEnhanceEntry(widget);
  if (!entry || !enhanceAuto(widget)) return null;
  return {
    positive_system: systemFor(entry, "positive", false),
    edit_system: systemFor(entry, "positive", true),
    negative_system: widget.modelUsesNegative() ? systemFor(entry, "negative", false) : "",
  };
}

export function installPromptEnhance(widget) {
  widgets.add(new WeakRef(widget));
  widget.promptBox.querySelectorAll("[data-enhance]").forEach((button) => {
    button.innerHTML = wandSvg();
    button.addEventListener("click", () => void runEnhance(widget, button));
  });
  void loadEnhanceDefaults().then(() => syncPromptEnhance(widget));
  syncPromptEnhance(widget);
}

/** The bbox as a small JPEG when it holds pixels (edit-style prompts are written looking at it). */
function canvasImage(widget) {
  if (!(widget.getRasterContentInBboxStats().nonzeroAlphaPixels > 0)) return null;
  const canvas = widget.makeExportCanvas("image", widget.getInferenceSize(), { fillBackground: true });
  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(canvas.width, canvas.height));
  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.round(canvas.width * scale));
  out.height = Math.max(1, Math.round(canvas.height * scale));
  out.getContext("2d").drawImage(canvas, 0, 0, out.width, out.height);
  return out.toDataURL("image/jpeg", 0.92);
}

async function runEnhance(widget, button) {
  if (button.classList.contains("working")) return;
  const kind = button.dataset.enhance;
  const textarea = button.parentElement.querySelector("textarea");
  const entry = activeEnhanceEntry(widget);
  const original = text(textarea.value);
  if (!entry || !original) {
    flash(button, "Type a prompt first");
    return;
  }
  button.classList.remove("error", "done");
  button.classList.add("working");
  button.setAttribute("aria-busy", "true");
  flowGradient(button, true);
  let succeeded = false;
  try {
    const image = kind === "positive" ? canvasImage(widget) : null;
    const settings = widget.makeSettingsPayload();
    delete settings.prompt_enhance; // the wand runs one rewrite; automatic mode is for draws
    const res = await fetch("/vnccs/unicanvas/enhance_prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, text: original, system_prompt: systemFor(entry, kind, Boolean(image)), image, settings, model: enhanceModel(widget) }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
    if (text(textarea.value) !== original) throw new Error("The prompt changed while it was being enhanced, so the result was dropped.");
    setTextareaValue(widget, textarea, String(data.prompt));
    succeeded = true;
  } catch (error) {
    flash(button, error.message || String(error));
    widget.setStatus(`Prompt enhance: ${error.message || error}`, true);
  } finally {
    flowGradient(button, false);
    button.classList.remove("working");
    button.removeAttribute("aria-busy");
  }
  if (succeeded) {
    button.classList.add("done");
    burstSparks(button);
    window.setTimeout(() => button.classList.remove("done"), 700);
  }
}

function flash(button, message) {
  button.classList.add("error");
  button.title = message;
  window.setTimeout(() => button.classList.remove("error"), 2500);
}

// insertText keeps the browser's undo stack, so Ctrl+Z brings the original prompt back.
function setTextareaValue(widget, textarea, value) {
  textarea.focus();
  textarea.select();
  let inserted = false;
  try { inserted = document.execCommand("insertText", false, value); } catch (_) { /* fall back below */ }
  if (!inserted || textarea.value !== value) {
    textarea.value = value;
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  }
  widget.resizeTextareaToContent(textarea);
}

// Sparkles and confetti bursting out of the wand: four-point stars and dots in the brand colours,
// flung outward, a little gravity, fading as they turn.
function burstSparks(button) {
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  const host = button.parentElement;
  const colors = ["#ff8fa3", "#b8a9e8", "#ffd166", "#7bdff2", "#ffffff"];
  const cx = button.offsetLeft + button.offsetWidth / 2;
  const cy = button.offsetTop + button.offsetHeight / 2;
  for (let index = 0; index < 30; index += 1) {
    const star = index % 3 !== 0;
    const size = star ? 6 + Math.random() * 7 : 3 + Math.random() * 3;
    const piece = document.createElement("span");
    piece.className = `vnccs-uc-enhance-spark ${star ? "star" : "dot"}`;
    piece.style.cssText = `left:${cx - size / 2}px; top:${cy - size / 2}px; width:${size}px; height:${size}px; background:${colors[index % colors.length]};`;
    host.appendChild(piece);
    const angle = Math.random() * Math.PI * 2;
    const distance = 22 + Math.random() * 44;
    const dx = Math.cos(angle) * distance;
    const dy = Math.sin(angle) * distance;
    piece.animate([
      { transform: "translate(0, 0) scale(.2) rotate(0deg)", opacity: 1 },
      { transform: `translate(${dx * 0.7}px, ${dy * 0.7}px) scale(1.1) rotate(${Math.random() * 180}deg)`, opacity: 1, offset: 0.4 },
      { transform: `translate(${dx}px, ${dy + 16}px) scale(.3) rotate(${Math.random() * 540}deg)`, opacity: 0 },
    ], { duration: 650 + Math.random() * 450, easing: "cubic-bezier(.15,.7,.3,1)" }).onfinish = () => piece.remove();
  }
}

const FIELDS = [
  ["positive", "Text-to-image prompt", "Used when the canvas is empty."],
  ["edit", "Edit prompt", "Image edit, inpaint, outpaint - written while looking at the canvas and references. Empty: use the text-to-image prompt."],
  ["negative", "Negative prompt", "Rewrites the negative box. Empty: no wand on the negative box."],
];
let dialogFamily = null;

const blankEntry = (family) => ({ family, positive: "", edit: "", negative: "" });
const hasPrompts = (entry) => Boolean(entry && (text(entry.positive) || text(entry.edit) || text(entry.negative)));
const sameEntry = (a, b) => FIELDS.every(([field]) => text(a?.[field]) === text(b?.[field]));

/**
 * The system-prompt dialog: one tab per model family, so a family can never be entered twice.
 * `families` is [{ key, label }]; every change is saved at once through `save` (the whole list, or
 * null once nothing differs from the shipped defaults).
 */
export function openPromptsDialog(families, save, onChange = () => {}) {
  if (!document.getElementById("vnccs-pe-css")) {
    const style = document.createElement("style");
    style.id = "vnccs-pe-css";
    style.textContent = DIALOG_CSS;
    document.head.appendChild(style);
  }
  const overlay = document.createElement("div");
  overlay.className = "vnccs-pe-overlay";
  overlay.innerHTML = `<div class="vnccs-pe-dialog" role="dialog" aria-modal="true" aria-labelledby="vnccs-pe-title">
    <div class="vnccs-pe-head"><h2 id="vnccs-pe-title">Prompt enhance - system prompts</h2><p>One tab per model family. Changes are saved as you type.</p></div>
    <div class="vnccs-pe-body"><div class="vnccs-pe-tabs" role="tablist" aria-orientation="vertical"></div><div class="vnccs-pe-pane" role="tabpanel"></div></div>
    <div class="vnccs-pe-foot"><span>A family without any system prompt has no magic wand.</span><button type="button" class="vnccs-pe-btn primary" data-close>Done</button></div>
  </div>`;
  const tabs = overlay.querySelector(".vnccs-pe-tabs");
  const pane = overlay.querySelector(".vnccs-pe-pane");
  const list = families.length ? families : enhanceEntries().map((entry) => ({ key: entry.family, label: entry.family }));
  const entryOf = (family) => enhanceEntries().find((entry) => entry.family === family) || blankEntry(family);
  const defaultOf = (family) => (defaultEntries || []).find((entry) => entry.family === family) || null;

  const store = (entry) => {
    const stored = uniqueByFamily(Array.isArray(readSetting(ENHANCE_PROMPTS_ID)) ? structuredClone(readSetting(ENHANCE_PROMPTS_ID)) : []).filter((item) => item.family !== entry.family);
    const shipped = defaultOf(entry.family);
    // Same as the shipped default: keep nothing, so later default updates still reach this family.
    if (!(shipped ? sameEntry(entry, shipped) : !hasPrompts(entry))) stored.push(entry);
    save(stored.length ? stored : null);
    onChange();
  };

  const paintTabs = () => {
    tabs.replaceChildren(...list.map((family) => {
      const tab = document.createElement("button");
      tab.type = "button";
      tab.role = "tab";
      tab.id = `vnccs-pe-tab-${family.key}`;
      tab.className = `vnccs-pe-tab${hasPrompts(entryOf(family.key)) ? " on" : ""}`;
      tab.setAttribute("aria-selected", String(family.key === dialogFamily));
      tab.tabIndex = family.key === dialogFamily ? 0 : -1;
      tab.innerHTML = '<span class="vnccs-pe-dot"></span><span></span>';
      tab.lastChild.textContent = family.label;
      tab.addEventListener("click", () => select(family.key));
      tab.addEventListener("keydown", (event) => {
        const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[event.key];
        if (!step) return;
        event.preventDefault();
        const index = list.findIndex((item) => item.key === dialogFamily);
        select(list[(index + step + list.length) % list.length].key, true);
      });
      return tab;
    }));
  };

  const paintPane = () => {
    const family = list.find((item) => item.key === dialogFamily) || list[0];
    const entry = structuredClone(entryOf(family.key));
    const shipped = defaultOf(family.key);
    pane.setAttribute("aria-labelledby", `vnccs-pe-tab-${family.key}`);
    const title = document.createElement("div");
    title.className = "vnccs-pe-title";
    title.innerHTML = "<h3></h3><span></span><span class='vnccs-pe-status'></span>";
    title.querySelector("h3").textContent = family.label;
    title.children[1].textContent = family.key;
    const status = title.querySelector(".vnccs-pe-status");
    const paintStatus = () => {
      status.classList.toggle("on", hasPrompts(entry));
      status.textContent = hasPrompts(entry) ? (shipped && sameEntry(entry, shipped) ? "Shipped default" : "Customised") : "No system prompt - no wand";
    };
    paintStatus();
    const fields = document.createElement("div");
    fields.className = "vnccs-pe-fields";
    const areas = {};
    for (const [field, label, help] of FIELDS) {
      const wrap = document.createElement("div");
      wrap.className = "vnccs-pe-field";
      const caption = document.createElement("label");
      caption.htmlFor = `vnccs-pe-${family.key}-${field}`;
      caption.innerHTML = "<span></span><small></small>";
      caption.firstChild.textContent = label;
      caption.lastChild.textContent = help;
      const area = document.createElement("textarea");
      area.id = caption.htmlFor;
      area.value = entry[field] || "";
      area.spellcheck = false;
      area.addEventListener("input", () => {
        entry[field] = area.value;
        store({ ...entry, family: family.key });
        paintStatus();
        paintTabs();
      });
      areas[field] = area;
      wrap.append(caption, area);
      fields.appendChild(wrap);
    }
    const actions = document.createElement("div");
    actions.className = "vnccs-pe-actions";
    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "vnccs-pe-btn";
    reset.textContent = "Reset to shipped default";
    reset.disabled = !shipped;
    reset.title = shipped ? "Discard your changes to this family" : "This family has no shipped default";
    reset.addEventListener("click", () => {
      store({ ...blankEntry(family.key), ...shipped, family: family.key });
      paintTabs();
      paintPane();
    });
    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "vnccs-pe-btn";
    clear.textContent = "Clear (no wand for this family)";
    clear.addEventListener("click", () => {
      store(blankEntry(family.key));
      paintTabs();
      paintPane();
    });
    actions.append(reset, clear);
    pane.replaceChildren(title, fields, actions);
  };

  const select = (family, focus = false) => {
    dialogFamily = family;
    paintTabs();
    paintPane();
    if (focus) tabs.querySelector('[aria-selected="true"]')?.focus();
  };

  // In real browser fullscreen only the fullscreen element's subtree is painted, so the dialog lives
  // inside it (and follows when fullscreen starts or ends while it is open).
  const mount = () => {
    const host = document.fullscreenElement || document.body;
    if (overlay.parentElement !== host) host.appendChild(overlay);
  };
  const close = () => {
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("fullscreenchange", mount);
    overlay.remove();
  };
  const onKey = (event) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    close();
  };
  overlay.addEventListener("pointerdown", (event) => { if (event.target === overlay) close(); });
  overlay.querySelector("[data-close]").addEventListener("click", close);
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("fullscreenchange", mount);
  mount();
  select(list.some((item) => item.key === dialogFamily) ? dialogFamily : list[0]?.key);
  void loadEnhanceDefaults().then(() => { paintTabs(); paintPane(); });
  return overlay;
}

/** The settings row: a button that opens the dialog and a one-line summary. */
export function buildPromptsButton(families, save) {
  const row = document.createElement("div");
  row.style.cssText = "display:flex; gap:10px; align-items:center;";
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Edit system prompts...";
  button.style.cssText = "padding:6px 14px; border-radius:8px; cursor:pointer;";
  const summary = document.createElement("span");
  summary.style.opacity = ".75";
  const paint = () => {
    const configured = enhanceEntries().filter(hasPrompts).length;
    summary.textContent = `${configured} of ${families.length || configured} model families have a system prompt`;
  };
  button.addEventListener("click", () => openPromptsDialog(families, save, paint));
  paint();
  void loadEnhanceDefaults().then(paint);
  row.append(button, summary);
  return row;
}

/**
 * The "Prompt enhance" section of the UniCanvas settings popover: the wand switch, automatic mode,
 * the wand's encoder (the popover's own `bind`/`makeSelect`, `installed` = the text encoder files) and
 * the way into the system-prompt dialog. `body` is the section body.
 */
export function buildPromptEnhanceSettings(s, { body, bind, makeSelect, installed = [], checkboxRow, commit, families, changed }) {
  const apply = (mutate) => { mutate(); commit(); changed(); };
  checkboxRow("Magic wand in the prompt boxes", s[ENHANCE_ENABLED] !== false, (checked) => apply(() => { s[ENHANCE_ENABLED] = checked; }),
    "Rewrites a prompt with a Qwen3-VL encoder and the system prompt of the model family. Never used while a VNCSS Config is linked.");
  checkboxRow("Always enhance when I press Generate", s[ENHANCE_AUTO] === true, (checked) => apply(() => { s[ENHANCE_AUTO] = checked; }),
    "The prompts are rewritten in the background right before generating; the boxes keep what you typed. This always uses the CLIP of the model family that draws, so it costs no extra VRAM.");
  const chosen = text(s[ENHANCE_MODEL]) || DEFAULT_ENHANCE_MODEL;
  const names = [...new Set([DEFAULT_ENHANCE_MODEL, ...installed.filter((name) => /qwen3.?vl/i.test(name)), chosen])];
  const select = makeSelect(names.map((name) => [name, name]), chosen);
  select.addEventListener("input", () => apply(() => { s[ENHANCE_MODEL] = select.value === DEFAULT_ENHANCE_MODEL ? "" : select.value; }));
  bind("Wand encoder", select).title = "The Qwen3-VL encoder the magic wand rewrites with. The default is the one Qwen-Image-2.1 uses; it downloads on first use and is unloaded again after each rewrite.";
  const edit = document.createElement("button");
  edit.type = "button";
  edit.className = "vnccs-uc-btn";
  edit.textContent = "Edit system prompts...";
  edit.title = "One tab per model family; also in the ComfyUI settings under VNCCS > UniCanvas > Prompt enhance";
  edit.addEventListener("click", () => openPromptsDialog(families, (value) => writeSetting(ENHANCE_PROMPTS_ID, value), changed));
  body.appendChild(edit);
}

/** The ComfyUI settings (VNCCS > UniCanvas > Prompt enhance): the system-prompt dictionary; `getFamilies` lists the model families. */
export function promptEnhanceSettingDefs(getFamilies) {
  const onChange = () => refreshAllPromptEnhance();
  return [
    {
      id: ENHANCE_PROMPTS_ID,
      category: ["VNCCS", "UniCanvas", "Prompt enhance"],
      name: "System prompts per model family",
      tooltip: "Opens a window with one tab per model family. A family without a system prompt has no wand. The wand, automatic mode and the wand's encoder are in the UniCanvas settings.",
      type: (_name, setter) => buildPromptsButton(getFamilies(), setter),
      defaultValue: null,
      onChange,
    },
  ];
}
