/**
 * VNCCS UniCanvas - run a VNCSS Config-linked draw inside UniCanvas instead of queueing the graph.
 *
 * GENERATE, remove bg and the other canvas tools use UniCanvas's own pipeline; the ComfyUI
 * workflow runs only when the user queues it for the final image. A linked VNCSS Config normally
 * hands over MODEL/CLIP/VAE tensors that exist only while the graph executes, so the draw used to
 * queue the whole workflow. Here the config's inputs are traced back to their loader nodes
 * (checkpoint / diffusion model / GGUF / CLIP / VAE loaders and LoadImage
 * references) and the same files are loaded by UniCanvas directly. Only when the chain holds
 * something UniCanvas cannot reproduce (a custom node patching the model, a generated reference
 * image) does the caller fall back to queueing the prompt.
 */

const MODEL_LOADERS = {
  CheckpointLoaderSimple: (node) => ({ model_loader: "checkpoint", ckpt_name: widget(node, "ckpt_name"), _ckptNode: node.id }),
  UNETLoader: (node) => ({ model_loader: "diffusion_model", diffusion_model_name: widget(node, "unet_name") }),
  UnetLoaderGGUF: (node) => ({ model_loader: "gguf", gguf_model_name: widget(node, "unet_name") }),
  UnetLoaderGGUFAdvanced: (node) => ({ model_loader: "gguf", gguf_model_name: widget(node, "unet_name") }),
};
const CLIP_LOADERS = {
  CLIPLoader: (node) => ({ clip_name: widget(node, "clip_name"), clip_type: lower(widget(node, "type")) }),
  CLIPLoaderGGUF: (node) => ({ clip_name: widget(node, "clip_name"), clip_type: lower(widget(node, "type")) }),
  CheckpointLoaderSimple: (node) => ({ _ckptNode: node.id }),
};
const VAE_LOADERS = {
  VAELoader: (node) => ({ vae_name: widget(node, "vae_name") }),
  CheckpointLoaderSimple: (node) => ({ _ckptNode: node.id }),
};
// Nodes that only pass their input through.
const PASS_THROUGH = new Set(["Reroute", "PrimitiveNode"]);

function lower(value) {
  return String(value || "").toLowerCase();
}

function widget(node, name) {
  return node?.widgets?.find?.((item) => item?.name === name)?.value;
}

function linkOf(graph, linkId) {
  if (linkId == null || !graph) return null;
  return graph.links?.get?.(linkId) ?? graph.links?.[linkId] ?? null;
}

/** The node feeding `inputName` of `node` (through reroutes), or null. */
export function upstreamNode(graph, node, inputName) {
  let current = node;
  let name = inputName;
  for (let hops = 0; hops < 32 && current; hops += 1) {
    const input = (current.inputs || []).find((item) => item?.name === name) || (name === null ? current.inputs?.[0] : null);
    const link = linkOf(graph, input?.link);
    if (!link) return null;
    const origin = graph.getNodeById?.(link.origin_id) ?? null;
    if (!origin || !PASS_THROUGH.has(origin.type)) return origin;
    current = origin;
    name = null;
  }
  return null;
}

/**
 * Returns the loader's settings, or { unsupported } for a chain the internal draw cannot replay.
 */
function walk(graph, node, inputName, loaders) {
  const current = upstreamNode(graph, node, inputName);
  if (!current) return { unsupported: `nothing is connected to ${inputName}` };
  const read = loaders[current.type];
  return read ? read(current) : { unsupported: `${current.title || current.type} (${current.type})` };
}

function configLoraStack(configNode) {
  let state = {};
  try {
    const raw = widget(configNode, "node_state");
    state = typeof raw === "string" ? JSON.parse(raw || "{}") : (raw || {});
  } catch {
    state = {};
  }
  return (Array.isArray(state?.loras) ? state.loras : [])
    .filter((item) => item && item.name && item.enabled !== false && Number(item.strength ?? 1) !== 0)
    .map((item) => ({ name: String(item.name), strength: Number(item.strength ?? 1),
      clip_strength: item.clip_strength == null || !Number.isFinite(Number(item.clip_strength)) ? null : Number(item.clip_strength) }));
}

/**
 * Settings that make an internal draw use exactly the config's models, or { unsupported }.
 * `references` lists the LoadImage files wired into reference_image_1..10 ({ filename, subfolder, type }).
 */
export function resolveConfigDrawSettings(graph, widgetNode) {
  const configNode = upstreamNode(graph, widgetNode, "config");
  if (!configNode) return { unsupported: "the VNCSS Config node was not found" };
  const model = walk(graph, configNode, "model", MODEL_LOADERS);
  if (model.unsupported) return { unsupported: `model: ${model.unsupported}` };
  const clip = walk(graph, configNode, "clip", CLIP_LOADERS);
  if (clip.unsupported) return { unsupported: `clip: ${clip.unsupported}` };
  const vae = walk(graph, configNode, "vae", VAE_LOADERS);
  if (vae.unsupported) return { unsupported: `vae: ${vae.unsupported}` };
  if (model.model_loader === "checkpoint") {
    // UniCanvas loads CLIP and VAE from the checkpoint itself.
    if (clip._ckptNode !== model._ckptNode || vae._ckptNode !== model._ckptNode) {
      return { unsupported: "a checkpoint model with a separate CLIP or VAE loader" };
    }
  } else if (clip._ckptNode != null || vae._ckptNode != null) {
    return { unsupported: "CLIP or VAE from a checkpoint next to a separate model file" };
  }
  const references = [];
  for (let index = 1; index <= 10; index += 1) {
    const source = upstreamNode(graph, configNode, `reference_image_${index}`);
    if (!source) continue;
    if (source.type !== "LoadImage") return { unsupported: `reference_image_${index} comes from ${source.type}` };
    const file = String(widget(source, "image") || "");
    if (!file) return { unsupported: `reference_image_${index} has no image` };
    const slash = Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\"));
    references.push({ slot: index, filename: slash >= 0 ? file.slice(slash + 1) : file, subfolder: slash >= 0 ? file.slice(0, slash) : "", type: "input" });
  }
  const settings = { model_loader: model.model_loader, model_selection_mode: "custom", lora_stack: configLoraStack(configNode) };
  for (const part of [model, clip, vae]) {
    for (const [key, value] of Object.entries(part)) {
      if (!key.startsWith("_") && key !== "model_loader" && value !== undefined && value !== "") settings[key] = value;
    }
  }
  return { settings, references };
}

/** LoadImage references as data URLs, preserving empty socket positions. */
export async function loadConfigReferences(references) {
  const urls = [];
  for (const ref of references || []) {
    const params = new URLSearchParams({ filename: ref.filename, subfolder: ref.subfolder || "", type: ref.type || "input" });
    const res = await fetch(`/view?${params.toString()}`);
    if (!res.ok) throw new Error(`reference ${ref.filename}: HTTP ${res.status}`);
    const blob = await res.blob();
    urls[(ref.slot ?? urls.length + 1) - 1] = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }
  return urls;
}
