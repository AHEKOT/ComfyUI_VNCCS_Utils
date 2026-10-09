import assert from "node:assert/strict";
import test from "node:test";
import { loadConfigReferences, resolveConfigDrawSettings } from "../web/unicanvas/config_bridge.mjs";

const node = (id, type, values = {}, inputs = []) => ({ id, type, inputs,
  widgets: Object.entries(values).map(([name, value]) => ({ name, value })) });

function graphWithConfig(loras = []) {
  const checkpoint = node(1, "CheckpointLoaderSimple", { ckpt_name: "model.safetensors" });
  const config = node(2, "VNCCS_Config", { node_state: JSON.stringify({ loras }) },
    ["model", "clip", "vae"].map((name, index) => ({ name, link: index + 1 })));
  const canvas = node(3, "VNCCS_UniCanvas", {}, [{ name: "config", link: 4 }]);
  const nodes = [checkpoint, config, canvas];
  const graph = { links: { 1: { origin_id: 1 }, 2: { origin_id: 1 }, 3: { origin_id: 1 }, 4: { origin_id: 2 } },
    getNodeById: id => nodes.find(item => item.id === id) };
  return { graph, config, canvas, nodes };
}

test("config LoRAs retain separate CLIP strengths, including zero", () => {
  const { graph, canvas } = graphWithConfig([
    { name: "model-only", strength: 1, clip_strength: 0 },
    { name: "separate", strength: .8, clip_strength: .2 },
    { name: "shared", strength: .7 },
    { name: "disabled", strength: 1, enabled: false },
  ]);
  const result = resolveConfigDrawSettings(graph, canvas);
  assert.equal(result.unsupported, undefined);
  assert.deepEqual(result.settings.lora_stack, [
    { name: "model-only", strength: 1, clip_strength: 0 },
    { name: "separate", strength: .8, clip_strength: .2 },
    { name: "shared", strength: .7, clip_strength: null },
  ]);
});

for (const type of ["LoraLoader", "LoraLoaderModelOnly"]) for (const input of ["model", "clip"]) {
  test(`${type} on ${input} uses the graph instead of changing its patches`, () => {
    const { graph, config, canvas, nodes } = graphWithConfig();
    nodes.push(node(4, type, { lora_name: "style", strength_model: 1, strength_clip: 0 },
      [{ name: "model", link: 5 }, { name: "clip", link: 6 }]));
    graph.links[5] = graph.links[6] = { origin_id: 1 };
    graph.links[config.inputs.find(item => item.name === input).link] = { origin_id: 4 };
    assert.match(resolveConfigDrawSettings(graph, canvas).unsupported, new RegExp(`${input}:.*${type}`));
  });
}

test("config reference socket gaps survive loading and JSON serialization", async () => {
  const { graph, config, canvas, nodes } = graphWithConfig();
  for (const slot of [3, 10]) {
    nodes.push(node(slot + 10, "LoadImage", { image: `refs/${slot}.png` }));
    config.inputs.push({ name: `reference_image_${slot}`, link: slot + 10 });
    graph.links[slot + 10] = { origin_id: slot + 10 };
  }
  const { references } = resolveConfigDrawSettings(graph, canvas);
  assert.deepEqual(references.map(ref => ref.slot), [3, 10]);
  const previousFetch = globalThis.fetch, previousReader = globalThis.FileReader;
  globalThis.fetch = async url => ({ ok: true, blob: async () => url });
  globalThis.FileReader = class {
    readAsDataURL(blob) { this.result = `data:${blob}`; this.onload(); }
  };
  try {
    const urls = JSON.parse(JSON.stringify(await loadConfigReferences(references)));
    assert.equal(urls.length, 10);
    assert.equal(urls[0], null);
    assert.equal(urls[1], null);
    assert.match(urls[2], /filename=3\.png/);
    assert.match(urls[9], /filename=10\.png/);
    assert.equal(urls.filter(Boolean).length, 2);
  } finally { globalThis.fetch = previousFetch; globalThis.FileReader = previousReader; }
});
