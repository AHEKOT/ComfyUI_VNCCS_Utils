// Prompt help ("?" next to the prompt) driven by the backend model-family descriptors.
//
// /vnccs/unicanvas/assets returns "model_modules": one UniCanvasModelModule.describe() per
// family, whose capabilities.prompt_guide carries a one-line hint and a short guide. A new
// family therefore gets its prompt help without any frontend change. The guide text comes
// from the server and is only ever written with textContent.

export const PROMPT_GUIDE_CSS = `
.vnccs-uc-prompt-head { display:flex; align-items:center; justify-content:space-between; gap:6px; }
.vnccs-uc-prompt-help { width:18px; height:18px; padding:0; border-radius:50%; border:1px solid var(--uc-border); background:rgba(255,255,255,.06); color:var(--uc-text); font:inherit; font-size:11px; line-height:16px; cursor:pointer; }
.vnccs-uc-prompt-help[aria-expanded="true"] { background:rgba(123,92,255,.35); border-color:rgba(160,140,255,.7); }
.vnccs-uc-prompt-guide { position:absolute; inset:0; z-index:40; display:flex; align-items:center; justify-content:center; padding:24px; box-sizing:border-box; background:rgba(8,6,12,.62); backdrop-filter:grayscale(.85); }
.vnccs-uc-prompt-guide[hidden] { display:none; }
.vnccs-uc-prompt-guide-card { display:flex; flex-direction:column; width:min(560px, 100%); max-height:100%; min-height:0; box-sizing:border-box; border:1px solid var(--uc-border); border-left:3px solid rgba(160,140,255,.8); border-radius:12px; background:var(--uc-panel, #17131f); color:var(--uc-text); box-shadow:0 18px 48px rgba(0,0,0,.55); zoom:var(--vnccs-uc-ui-scale, 1); }
.vnccs-uc-prompt-guide-bar { display:flex; align-items:center; gap:6px; padding:8px 10px; border-bottom:1px solid var(--uc-border); }
.vnccs-uc-prompt-guide-bar strong { flex:1; font-size:12px; }
.vnccs-uc-prompt-guide-body { display:flex; flex-direction:column; gap:6px; padding:10px 12px; overflow:auto; min-height:0; font-size:12px; line-height:1.45; user-select:text; }
.vnccs-uc-prompt-guide-title { font-weight:600; }
.vnccs-uc-prompt-guide-meta { color:var(--uc-muted); }
.vnccs-uc-prompt-guide-examples { margin:0; padding-left:16px; }
.vnccs-uc-prompt-guide-examples li { font-family:monospace; white-space:pre-wrap; }
`;

export function indexModelDescriptors(modelModules) {
  const index = new Map();
  for (const descriptor of Array.isArray(modelModules) ? modelModules : []) {
    if (!descriptor || !descriptor.key) continue;
    index.set(String(descriptor.key).toLowerCase(), descriptor);
    for (const alias of descriptor.aliases || []) index.set(String(alias).toLowerCase(), descriptor);
  }
  return index;
}

export function referenceSlotLabels(references) {
  if (!references || !references.slot_label) return [];
  const count = Math.max(0, Number(references.max_images) || 0) + 1; // slot 1 is the working area
  return Array.from({ length: count }, (_, index) => String(references.slot_label).replace("{n}", String(index + 1)));
}

// taskKey (e.g. "image_to_video") selects the task's own guide when the family declares one;
// without it the family-wide guide is used and taskGuides lists the tasks that prompt differently.
export function resolvePromptGuide(index, generationMode, taskKey = null) {
  const descriptor = index?.get(String(generationMode || "").toLowerCase());
  const capabilities = descriptor?.capabilities;
  if (!capabilities?.prompt_guide) return null;
  const tasks = Array.isArray(capabilities.tasks) ? capabilities.tasks : [];
  const task = taskKey ? tasks.find((entry) => entry.key === taskKey) : null;
  const guide = task?.prompt_guide || capabilities.prompt_guide;
  return {
    key: descriptor.key,
    label: capabilities.label || descriptor.key,
    role: descriptor.role || "",
    task: task ? task.label : null,
    taskGuides: task ? [] : tasks.filter((entry) => entry.prompt_guide).map((entry) => ({ task: entry.label, hint: String(entry.prompt_guide.hint || "") })),
    hint: String(guide.hint || ""),
    paragraphs: String(guide.guide || "").split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean),
    examples: (guide.examples || []).map(String),
    sources: (guide.sources || []).map(String),
    negativePrompt: guide.negative_prompt !== false,
    tasks: tasks.filter((task) => task.available !== false).map((task) => task.label),
    plannedTasks: tasks.filter((task) => task.available === false).map((task) => task.label),
    referenceSlots: referenceSlotLabels(capabilities.references),
  };
}

function textElement(doc, tag, className, text) {
  const element = doc.createElement(tag);
  element.className = className;
  element.textContent = text;
  return element;
}

// How the prompt of an edit family names its pictures, e.g. for Qwen-Image-2.1:
// 'Write <image1> for the working area and <image2>, <image3>, ... for the references, e.g. "..."'.
export function referenceUsageLines(guide) {
  if (!guide) return [];
  const slots = guide.referenceSlots || [];
  if (slots.length) {
    const tag = /[<>@]/.test(slots[0]);
    const example = `Put the character from ${slots[1] || slots[0]} into ${slots[0]}, keep the lighting of ${slots[0]}.`;
    return [
      `Referring to images: ${slots[0]} is the working area (the canvas inside the bbox); ${slots.slice(1, 4).join(", ")}${slots.length > 4 ? ", ..." : ""} are the reference images in upload / VNCSS Config order.`,
      tag
        ? `Write the tags exactly as shown (with the angle brackets), e.g. "${example}"`
        : `Write the names in plain words, e.g. "${example}"`,
    ];
  }
  if (guide.role === "edit") {
    return ["Referring to images: this model has no image tags - describe what to change in the working area in plain words (\"the woman\", \"the background\")."];
  }
  return [];
}

// Plain-text form of the guide for the Copy button, ready to paste into an LLM.
export function promptGuideText(guide) {
  if (!guide) return "No prompt guide for this model.";
  const lines = [guide.task ? `${guide.label} - ${guide.task} - how to prompt` : `${guide.label} - how to prompt`, ""];
  for (const paragraph of guide.paragraphs) lines.push(paragraph, "");
  for (const line of referenceUsageLines(guide)) lines.push(line);
  if (!guide.negativePrompt) lines.push("This model does not use the negative prompt.");
  if (guide.tasks.length) lines.push(`Tasks: ${guide.tasks.join(", ")}`);
  for (const entry of guide.taskGuides || []) lines.push(`${entry.task} prompts differently: ${entry.hint}`);
  if (guide.examples.length) {
    lines.push("", "Examples:");
    for (const example of guide.examples) lines.push(`- ${example}`);
  }
  if (guide.sources?.length) lines.push("", `Sources: ${guide.sources.join(" | ")}`);
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function renderPromptGuide(container, guide, doc = globalThis.document) {
  if (!guide) {
    container.replaceChildren(textElement(doc, "div", "vnccs-uc-prompt-guide-meta", "No prompt guide for this model."));
    return;
  }
  const title = guide.task ? `${guide.label} - ${guide.task} - how to prompt` : `${guide.label} - how to prompt`;
  const nodes = [textElement(doc, "div", "vnccs-uc-prompt-guide-title", title)];
  for (const paragraph of guide.paragraphs) nodes.push(textElement(doc, "div", "vnccs-uc-prompt-guide-text", paragraph));
  for (const line of referenceUsageLines(guide)) nodes.push(textElement(doc, "div", "vnccs-uc-prompt-guide-meta", line));
  if (!guide.negativePrompt) nodes.push(textElement(doc, "div", "vnccs-uc-prompt-guide-meta", "This model does not use the negative prompt."));
  if (guide.tasks.length) nodes.push(textElement(doc, "div", "vnccs-uc-prompt-guide-meta", `Tasks: ${guide.tasks.join(", ")}`));
  if (guide.plannedTasks.length) nodes.push(textElement(doc, "div", "vnccs-uc-prompt-guide-meta", `Coming later: ${guide.plannedTasks.join(", ")}`));
  for (const entry of guide.taskGuides || []) {
    nodes.push(textElement(doc, "div", "vnccs-uc-prompt-guide-meta", `${entry.task} prompts differently: ${entry.hint}`));
  }
  if (guide.examples.length) {
    nodes.push(textElement(doc, "div", "vnccs-uc-prompt-guide-meta", "Examples:"));
    const list = doc.createElement("ul");
    list.className = "vnccs-uc-prompt-guide-examples";
    list.append(...guide.examples.map((example) => textElement(doc, "li", "", example)));
    nodes.push(list);
  }
  if (guide.sources?.length) nodes.push(textElement(doc, "div", "vnccs-uc-prompt-guide-meta", `Sources: ${guide.sources.join(" | ")}`));
  container.replaceChildren(...nodes);
}

// How a family's prompt names reference picture `slot` (slot 1 is the working area). The
// convention comes from the backend descriptor (capabilities.references.slot_label):
// "<image{n}>" (Qwen-Image-2.1 tags), "Picture {n}" (Qwen Image Edit plain words), ... A family
// without a slot label has no reference syntax: the prompt describes the image in words.
export function referenceSlotName(index, generationMode, slot) {
  const descriptor = index?.get?.(String(generationMode || "").toLowerCase());
  const family = descriptor?.capabilities?.label || descriptor?.key || "";
  const label = descriptor?.capabilities?.references?.slot_label;
  if (label) return { text: String(label).replace("{n}", String(slot)), tag: /[<>@]/.test(label), natural: false, family, known: true };
  return { text: `image ${slot}`, tag: false, natural: true, family, known: Boolean(descriptor) };
}

export function referenceConventionHint(index, generationMode) {
  const first = referenceSlotName(index, generationMode, 1);
  const second = referenceSlotName(index, generationMode, 2);
  const third = referenceSlotName(index, generationMode, 3);
  if (!first.known) return "The reference name follows the linked UniCanvas Mode (model family).";
  if (first.natural) {
    return `${first.family}: no reference tags - describe each reference in plain words (e.g. "the character from the second image").`;
  }
  if (first.tag) return `${first.family}: references are ${second.text}, ${third.text}, ... in the prompt; ${first.text} is the working area.`;
  return `${first.family}: say "${second.text}", "${third.text}", ... in plain words; ${first.text} is the working area.`;
}
