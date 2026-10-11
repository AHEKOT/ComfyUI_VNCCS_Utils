import { normalizeState, promptId } from "./state.mjs";

function mapReferences(value, blockId) {
    if (Array.isArray(value)) return value.map(item => mapReferences(item, blockId));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
        .map(([key, item]) => [key, key === "blockId" ? blockId(item) : mapReferences(item, blockId)]));
    return value;
}

export function promptSnapshot(state) {
    const { promptTabs, activePrompt, ...document } = state;
    const snapshot = normalizeState(document), used = new Set();
    mapReferences(snapshot.parts, id => { if (id) used.add(id); return id; });
    return normalizeState({ ...snapshot, blocks: snapshot.blocks.filter(block => used.has(block.id)), openTabs: [], activeTab: "prompt" });
}

export function promptSignature(state, details = {}) {
    const snapshot = promptSnapshot(state);
    const categories = new Set([...snapshot.blocks.map(block => block.category), details.category]);
    return JSON.stringify({ ...snapshot, blocks: snapshot.blocks.sort((a, b) => a.id.localeCompare(b.id)),
        categories: snapshot.categories.filter(category => categories.has(category.name)).sort((a, b) => a.name.localeCompare(b.name)),
        cycleIndex: undefined, details: { name: details.name ?? "", category: details.category ?? "", color: details.color ?? "#b8a9e8" } });
}

export function mergeCategories(current, incoming) {
    const categories = new Map(current.map(category => [category.name.toLowerCase(), category]));
    for (const category of incoming) {
        const key = category.name.toLowerCase();
        categories.set(key, { ...category, ...categories.get(key) });
    }
    return [...categories.values()];
}

export function openPromptState(current, saved) {
    const snapshot = normalizeState(saved), blocks = [...current.blocks], ids = new Map();
    const categories = mergeCategories(current.categories, snapshot.categories);
    for (const source of snapshot.blocks) {
        const category = categories.find(category => category.name.toLowerCase() === source.category?.toLowerCase());
        const block = category ? { ...source, category: category.name } : source;
        const same = blocks.find(item => JSON.stringify({ ...item, id: "" }) === JSON.stringify({ ...block, id: "" }));
        const id = same?.id ?? (blocks.some(item => item.id === block.id) ? promptId() : block.id);
        ids.set(block.id, id);
        if (!same) blocks.push({ ...block, id });
    }
    return normalizeState({ ...current, blocks, categories, parts: mapReferences(snapshot.parts, id => ids.get(id) ?? id),
        seed: snapshot.seed, cycleIndex: snapshot.cycleIndex, afterGenerate: snapshot.afterGenerate, activeTab: "prompt" });
}
