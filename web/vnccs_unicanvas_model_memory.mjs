// Remembers the models a user picked in the Custom tab, per loader + Mode.
// The data lives on the server, in the user's ComfyUI user directory (nodes/unicanvas/user_prefs.py,
// versioned file), so every UniCanvas in every browser starts from the files used last time.
// This module keeps one shared in-memory copy: recalling is synchronous, saving is a small POST.

export const MODEL_MEMORY_ROUTE = "/vnccs/unicanvas/model_memory";
// Asset fields (settings key -> the assets list that must still contain the remembered file).
export const MODEL_MEMORY_ASSET_FIELDS = {
    ckpt_name: "checkpoints",
    diffusion_model_name: "diffusion_models",
    gguf_model_name: "gguf_models",
    clip_name: "text_encoders",
    vae_name: "vae_models",
};
const PLAIN_FIELDS = ["clip_type", "gguf_arch"];

export const modelMemoryKey = (settings) => `${settings?.model_loader || "checkpoint"}|${settings?.generation_mode || "sdxl"}`;

function loraRows(stack) {
    return (Array.isArray(stack) ? stack : [])
        .map((item) => ({ name: String(item?.name || ""), strength: Number.isFinite(Number(item?.strength)) ? Number(item.strength) : 1 }))
        .filter((item) => item.name);
}

export function entryFromSettings(settings) {
    const entry = { at: Date.now() };
    for (const key of [...Object.keys(MODEL_MEMORY_ASSET_FIELDS), ...PLAIN_FIELDS]) {
        if (typeof settings[key] === "string" && settings[key]) entry[key] = settings[key];
    }
    entry.lora_stack = loraRows(settings.lora_stack);
    return entry;
}

// The remembered picks for this loader + Mode as a settings patch. A file that is no longer in
// `assets` is dropped (assets omitted or an empty list = not loaded yet, everything is kept).
export function patchFromEntry(entry, assets = null) {
    if (!entry || typeof entry !== "object") return {};
    const patch = {};
    for (const [key, assetList] of Object.entries(MODEL_MEMORY_ASSET_FIELDS)) {
        if (typeof entry[key] !== "string" || !entry[key]) continue;
        const known = assets?.[assetList];
        if (Array.isArray(known) && known.length && !known.includes(entry[key])) continue;
        patch[key] = entry[key];
    }
    for (const key of PLAIN_FIELDS) if (typeof entry[key] === "string" && entry[key]) patch[key] = entry[key];
    const loras = loraRows(entry.lora_stack);
    if (loras.length) {
        const known = assets?.loras;
        const usable = Array.isArray(known) && known.length ? loras.filter((item) => known.includes(item.name)) : loras;
        if (usable.length) { patch.lora_stack = usable; patch.lora_rows = usable.length; }
    }
    return patch;
}

export class ModelMemory {
    constructor(fetchImpl = (...args) => globalThis.fetch(...args)) {
        this.fetch = fetchImpl;
        this.entries = {};
        this.loading = null;
        this.pending = new Map();
        this.timer = null;
    }

    // Loads the server copy once; failures leave an empty memory (nothing is recalled, nothing breaks).
    load() {
        this.loading ||= this.fetch(MODEL_MEMORY_ROUTE, { cache: "no-store" })
            .then((res) => (res.ok ? res.json() : {}))
            .then((document) => {
                if (document?.entries && typeof document.entries === "object") this.entries = { ...document.entries, ...this.entries };
            })
            .catch(() => {});
        return this.loading;
    }

    recall(settings, assets = null) {
        return patchFromEntry(this.entries[modelMemoryKey(settings)], assets);
    }

    // Updates the local copy at once and saves it shortly after (a burst of edits is one request per key).
    remember(settings) {
        const key = modelMemoryKey(settings);
        const entry = entryFromSettings(settings);
        this.entries[key] = entry;
        this.pending.set(key, entry);
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.flush(), 400);
    }

    flush() {
        clearTimeout(this.timer);
        const batch = [...this.pending];
        this.pending.clear();
        return Promise.all(batch.map(([key, entry]) => this.fetch(MODEL_MEMORY_ROUTE, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ key, entry }),
        }).catch(() => {})));
    }
}

let shared = null;
export const sharedModelMemory = () => (shared ||= new ModelMemory());
