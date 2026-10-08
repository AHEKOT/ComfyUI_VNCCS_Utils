/**
 * VNCCS UniCanvas - content-based layer names (a small local VLM, backend describe_layers route).
 *
 * - "Auto-name" in the layer context menu names that layer from its pixels (on demand).
 * - The "Auto-name new layers" setting (off by default) names imported and accepted layers
 *   in the background. Those keep their provisional name until the answer arrives, and a
 *   name the user typed (nameSource "user") is never replaced automatically.
 * The model is picked in the settings (Qwen3-VL 2B by default, SmolVLM 256M as the light option);
 * the first use downloads it and the status line says so.
 */

export const DESCRIBE_LAYERS_ROUTE = "/vnccs/unicanvas/describe_layers";
export const AUTO_NAME_SETTING = "auto_name_layers";
export const AUTO_NAME_MODEL_SETTING = "auto_name_model";
export const AUTO_NAME_MODELS = [
  ["qwen3vl_2b", "Qwen3-VL 2B (recognizes what it sees, ~4 GB)"],
  ["smolvlm_256m", "SmolVLM 256M (fast, vague, ~500 MB)"],
];
const AUTO_NAME_DOWNLOAD = { qwen3vl_2b: "~4 GB", smolvlm_256m: "~500 MB" };

export function resolveAutoNameModel(settings) {
  const value = settings?.[AUTO_NAME_MODEL_SETTING];
  return AUTO_NAME_MODELS.some(([key]) => key === value) ? value : AUTO_NAME_MODELS[0][0];
}

function layerImageDataURL(uc, layer) {
  const crop = uc.getLayerAlphaBounds?.(layer);
  if (!crop) return null;
  return uc.cloneCanvasCrop(layer.canvas, crop).toDataURL("image/png");
}

/** Names `layers` from their content. `automatic` skips layers the user named. */
export async function autoNameLayers(uc, layers, { automatic = false } = {}) {
  const targets = layers.filter((layer) => layer && layer.type !== "mask" && !(automatic && layer.nameSource === "user"));
  const items = targets.map((layer) => ({ id: layer.id, image: layerImageDataURL(uc, layer) })).filter((item) => item.image);
  if (!items.length) {
    if (!automatic) uc.setStatus("[VNCCS UniCanvas] Auto-name: the layer is empty.", true);
    return;
  }
  // The content can change while the model runs: an answer only applies to the pixels it saw.
  const tokens = new Map(items.map((item) => [item.id, (uc._vnccsNameTokens ||= new Map()).set(item.id, Symbol("name")).get(item.id)]));
  const model = resolveAutoNameModel(uc.settings);
  const label = AUTO_NAME_MODELS.find(([key]) => key === model)[1].split(" (")[0];
  uc.setStatus(`[VNCCS UniCanvas] Naming layers with ${label} (first use downloads ${AUTO_NAME_DOWNLOAD[model]})...`);
  try {
    const res = await fetch(DESCRIBE_LAYERS_ROUTE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ layers: items, model }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
    let renamed = 0;
    for (const entry of data.names || []) {
      const layer = uc.layers.find((item) => item.id === entry.id);
      if (!layer || !entry.name || uc._vnccsNameTokens.get(entry.id) !== tokens.get(entry.id)) continue;
      if (automatic && layer.nameSource === "user") continue;
      layer.name = entry.name;
      layer.nameSource = "auto";
      uc.refreshLayerRow?.(layer.id);
      renamed += 1;
    }
    if (renamed) uc.syncLightStateToWidget?.();
    uc.setStatus(renamed ? `[VNCCS UniCanvas] Named ${renamed} layer${renamed === 1 ? "" : "s"}.` : "[VNCCS UniCanvas] Auto-name found no name.");
  } catch (err) {
    uc.setStatus(`[VNCCS UniCanvas] Auto-name failed: ${err.message || err}`, true);
  }
}

/** Hook for new content layers: names them only when the setting is on. */
export function maybeAutoNameLayer(uc, layer) {
  if (!uc?.settings?.[AUTO_NAME_SETTING] || !layer) return;
  void autoNameLayers(uc, [layer], { automatic: true });
}
