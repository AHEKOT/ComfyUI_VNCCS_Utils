import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  indexModelDescriptors,
  resolvePromptGuide,
  referenceSlotLabels,
  renderPromptGuide,
} from "../web/vnccs_unicanvas_prompt_guide.mjs";

const guideSource = await readFile(new URL("../web/vnccs_unicanvas_prompt_guide.mjs", import.meta.url), "utf8");
const mainSource = await readFile(new URL("../web/vnccs_unicanvas.js", import.meta.url), "utf8");

// The /vnccs/unicanvas/assets "model_modules" shape (UniCanvasModelModule.describe()).
const MODEL_MODULES = [
  {
    key: "qwen_image21",
    aliases: ["qi21"],
    role: "edit",
    capabilities: {
      label: "Qwen Image 2.1",
      tasks: [
        { key: "text_to_image", label: "Text to image", available: true, output: "image" },
        {
          key: "image_to_video",
          label: "Image to video",
          available: false,
          output: "video",
          prompt_guide: { hint: "Describe the motion", guide: "Motion first.\n\nThen camera.", examples: [], negative_prompt: false },
        },
      ],
      accepts: ["image", "text"],
      references: { max_images: 2, accepts: ["image"], slot_label: "<image{n}>" },
      prompt_guide: {
        hint: "Describe the result; name references as <image2>",
        guide: "First paragraph.\n\nSecond paragraph.",
        examples: ["Keep the identity from <image2>."],
        negative_prompt: true,
        sources: ["https://example.com/qi21-guide"],
      },
    },
  },
  {
    key: "sdxl",
    aliases: ["illustrious"],
    role: "generator",
    capabilities: {
      label: "SDXL",
      tasks: [{ key: "text_to_image", label: "Text to image", available: true, output: "image" }],
      accepts: ["text"],
      references: null,
      prompt_guide: { hint: "Tags", guide: "Use tags.", examples: [], negative_prompt: true },
    },
  },
];

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.className = "";
    this.textContent = "";
    this.attributes = {};
  }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = [...nodes]; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  get allText() { return [this.textContent, ...this.children.map((child) => child.allText)].join(" "); }
  find(className) {
    if (this.className.split(" ").includes(className)) return this;
    for (const child of this.children) {
      const found = child.find(className);
      if (found) return found;
    }
    return null;
  }
}
const fakeDocument = { createElement: (tag) => new FakeElement(tag) };

test("descriptors are indexed by key and alias", () => {
  const index = indexModelDescriptors(MODEL_MODULES);
  assert.equal(index.get("qi21").key, "qwen_image21");
  assert.equal(index.get("ILLUSTRIOUS".toLowerCase()).key, "sdxl");
  assert.equal(indexModelDescriptors(null).size, 0);
});

test("the prompt guide of the active family is resolved", () => {
  const index = indexModelDescriptors(MODEL_MODULES);
  const guide = resolvePromptGuide(index, "qi21");
  assert.equal(guide.label, "Qwen Image 2.1");
  assert.equal(guide.hint, "Describe the result; name references as <image2>");
  assert.deepEqual(guide.paragraphs, ["First paragraph.", "Second paragraph."]);
  assert.deepEqual(guide.examples, ["Keep the identity from <image2>."]);
  assert.deepEqual(guide.tasks, ["Text to image"]);
  assert.deepEqual(guide.plannedTasks, ["Image to video"]);
  assert.equal(guide.negativePrompt, true);
  assert.deepEqual(guide.sources, ["https://example.com/qi21-guide"]);
  assert.equal(resolvePromptGuide(index, "unknown"), null);
});

test("a task with its own guide overrides the family guide", () => {
  const index = indexModelDescriptors(MODEL_MODULES);
  const video = resolvePromptGuide(index, "qwen_image21", "image_to_video");
  assert.equal(video.hint, "Describe the motion");
  assert.deepEqual(video.paragraphs, ["Motion first.", "Then camera."]);
  assert.equal(video.negativePrompt, false);
  assert.equal(video.task, "Image to video");
  const image = resolvePromptGuide(index, "qwen_image21", "text_to_image");
  assert.equal(image.hint, "Describe the result; name references as <image2>");
  assert.equal(image.task, "Text to image");
  // The family guide lists the tasks that prompt differently.
  const family = resolvePromptGuide(index, "qwen_image21");
  assert.deepEqual(family.taskGuides, [{ task: "Image to video", hint: "Describe the motion" }]);
});

test("reference slots list the working area and every reference", () => {
  assert.deepEqual(referenceSlotLabels({ max_images: 2, slot_label: "<image{n}>" }), ["<image1>", "<image2>", "<image3>"]);
  assert.deepEqual(referenceSlotLabels(null), []);
});

test("the guide renders as text nodes only", () => {
  const index = indexModelDescriptors(MODEL_MODULES);
  const container = new FakeElement("div");
  renderPromptGuide(container, resolvePromptGuide(index, "qwen_image21"), fakeDocument);
  const text = container.allText;
  for (const expected of ["Qwen Image 2.1", "First paragraph.", "Second paragraph.", "Keep the identity from <image2>.", "<image1>", "<image3>", "Image to video", "Describe the motion", "https://example.com/qi21-guide"]) {
    assert.ok(text.includes(expected), `missing ${expected}`);
  }
  assert.ok(container.find("vnccs-uc-prompt-guide-examples"));
  renderPromptGuide(container, null, fakeDocument);
  assert.match(container.allText, /No prompt guide/);
  assert.doesNotMatch(guideSource, /innerHTML/, "guide text comes from model descriptors: never parse it as HTML");
});

test("the widget wires the prompt help to the backend descriptors", () => {
  assert.match(mainSource, /from "\.\/vnccs_unicanvas_prompt_guide\.mjs(\?v=\d+)?"/);
  assert.match(mainSource, /data-prompt-help/);
  assert.match(mainSource, /dataset\.promptGuide = ""/, "the guide overlay keeps its data-prompt-guide hook");
  assert.match(mainSource, /indexModelDescriptors\(data\.model_modules\)/);
  assert.match(mainSource, /syncPromptGuide\(\)/);
  assert.match(mainSource, /PROMPT_GUIDE_CSS/);
});
