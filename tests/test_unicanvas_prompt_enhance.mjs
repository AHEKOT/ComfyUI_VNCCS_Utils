import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_ENHANCE_MODEL,
  ENHANCE_AUTO,
  ENHANCE_ENABLED,
  ENHANCE_MODEL,
  ENHANCE_PROMPTS_ID,
  activeEnhanceEntry,
  bindEnhanceSettingsReader,
  enhanceEntries,
  enhanceModel,
  mergeEntries,
  promptEnhancePayload,
  promptEnhanceSettingDefs,
  stripEnhanceSettings,
  uniqueByFamily,
} from "../web/vnccs_unicanvas_prompt_enhance.mjs";

const QI21 = { family: "qwen_image21", positive: "T2I:", edit: "EDIT:", negative: "NEG:" };
const KREA = { family: "krea2_edit", positive: "", edit: "KREA:", negative: "" };

function useStored(stored = [QI21, KREA]) {
  bindEnhanceSettingsReader((id) => (id === ENHANCE_PROMPTS_ID ? stored : undefined));
}

function widget(settings = {}, { linked = false, family = "qwen_image21", usesNegative = true } = {}) {
  return { settings, _isConfigLinked: () => linked, getModelKey: () => family, modelUsesNegative: () => usesNegative };
}

test("the wand needs an entry with a system prompt for the current family", () => {
  useStored();
  assert.equal(activeEnhanceEntry(widget()), QI21);
  assert.equal(activeEnhanceEntry(widget({}, { family: "sdxl" })), null);
  assert.ok(activeEnhanceEntry(widget({}, { family: "krea2_edit" })), "an edit-only entry is enough");
  useStored([{ ...QI21, positive: " ", edit: "" }]);
  assert.equal(activeEnhanceEntry(widget()), null);
});

test("a linked VNCSS Config or the off switch disables enhance entirely", () => {
  useStored();
  assert.equal(activeEnhanceEntry(widget({}, { linked: true })), null);
  assert.equal(activeEnhanceEntry(widget({ [ENHANCE_ENABLED]: false })), null);
  assert.equal(promptEnhancePayload(widget({ [ENHANCE_AUTO]: true }, { linked: true })), null, "automatic mode must not reach a config-linked draw");
});

test("automatic mode (the node switch) resolves the systems, and never names an encoder", () => {
  useStored();
  assert.equal(promptEnhancePayload(widget()), null, "off by default");
  const payload = promptEnhancePayload(widget({ [ENHANCE_AUTO]: true, [ENHANCE_MODEL]: "other.safetensors" }));
  assert.deepEqual(payload, { positive_system: "T2I:", edit_system: "EDIT:", negative_system: "NEG:" });
  assert.equal(promptEnhancePayload(widget({ [ENHANCE_AUTO]: true }, { usesNegative: false })).negative_system, "", "a family without a negative prompt never enhances it");
  assert.equal(promptEnhancePayload(widget({ [ENHANCE_AUTO]: true }, { family: "krea2_edit" })).positive_system, "KREA:", "text-to-image falls back to the edit prompt when none is written");
});

test("the wand's encoder is the node's choice, with the QI2.1 encoder as default", () => {
  assert.equal(enhanceModel(widget()), DEFAULT_ENHANCE_MODEL);
  assert.equal(enhanceModel(widget({ [ENHANCE_MODEL]: "qwen3vl_4b_fp8_scaled.safetensors" })), "qwen3vl_4b_fp8_scaled.safetensors");
});

test("node-level switches never travel with a draw", () => {
  const settings = stripEnhanceSettings({ positive: "cat", [ENHANCE_ENABLED]: true, [ENHANCE_AUTO]: true, [ENHANCE_MODEL]: "x" });
  assert.deepEqual(settings, { positive: "cat" });
});

test("a family can hold only one entry: the first wins", () => {
  assert.deepEqual(uniqueByFamily([QI21, { ...KREA }, { ...QI21, positive: "dup" }, { family: "" }, null]), [QI21, KREA]);
  useStored([QI21, { ...QI21, positive: "dup" }]);
  assert.deepEqual(enhanceEntries(), [QI21]);
});

test("the user's entries override the shipped defaults per family, even a cleared one", () => {
  const cleared = { family: "krea2_edit", positive: "", edit: "", negative: "" };
  const custom = { ...QI21, positive: "mine" };
  assert.deepEqual(mergeEntries([QI21, KREA], null), [QI21, KREA]);
  assert.deepEqual(mergeEntries([QI21, KREA], [custom, cleared]), [custom, cleared]);
  assert.deepEqual(mergeEntries([QI21, KREA], [{ family: "flux_klein", positive: "x", edit: "", negative: "" }]).map((entry) => entry.family), ["qwen_image21", "krea2_edit", "flux_klein"]);
});

test("the system-prompt dictionary lives in VNCCS > UniCanvas > Prompt enhance", () => {
  const defs = promptEnhanceSettingDefs(() => []);
  assert.deepEqual(defs.map((def) => def.id), [ENHANCE_PROMPTS_ID]);
  assert.deepEqual(defs[0].category, ["VNCCS", "UniCanvas", "Prompt enhance"]);
});
