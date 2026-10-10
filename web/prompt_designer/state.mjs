export const MAX_STATE_CHARS = 256 * 1024;
export const MAX_PROMPT_CHARS = 64 * 1024;
export const MAX_PROMPT_OUTPUTS = 16;
export const CONDITION_OPERATORS = { contains: "contains", equals: "equals", not_equals: "does not equal", not_contains: "does not contain" };

export function defaultState() {
    return {
        version: 1,
        categories: ["Clothes", "Styles", "Colors", "Hair", "Backgrounds"].map(name => ({ name })),
        blocks: [],
        parts: [],
        seed: "0", afterGenerate: "randomize", openTabs: [], activeTab: "prompt",
    };
}

export function mergeText(parts) {
    const result = [];
    for (const part of parts) {
        if ("text" in part) {
            if (!part.text) continue;
            if (result.at(-1)?.text !== undefined) result.at(-1).text += part.text;
            else result.push({ text: part.text });
        } else if ("multiPrompt" in part) result.push({ multiPrompt: { variants: part.multiPrompt.variants.map(mergeText) } });
        else if ("condition" in part) result.push({ condition: { ...part.condition, then: part.condition.then.parts
            ? { parts: mergeText(part.condition.then.parts) } : { ...part.condition.then },
            ...(part.condition.clauses === undefined ? {} : { clauses: part.condition.clauses.map(clause => ({ ...clause })) }),
            ...(part.condition.else === undefined ? {} : { else: part.condition.else.parts
                ? { parts: mergeText(part.condition.else.parts) } : { ...part.condition.else } }) } });
        else result.push({ blockId: part.blockId });
    }
    return result;
}

export function outputCount(state) {
    return Math.max(1, ...state.parts.filter(part => part.multiPrompt).map(part => part.multiPrompt.variants.length));
}

export function hasCycle(state) {
    const cyclic = text => /\{\s*@/.test(text);
    const blockCycles = id => {
        const block = state.blocks.find(block => block.id === id);
        return block?.mode === "cycle" || (block?.mode !== "random" && cyclic(block?.text ?? ""));
    };
    const cycles = part => {
        if ("text" in part) return cyclic(part.text);
        if ("blockId" in part) return blockCycles(part.blockId);
        if (part.multiPrompt) return part.multiPrompt.variants.some(variant => variant.some(cycles));
        const condition = part.condition;
        return [condition, ...(condition.clauses ?? [])].some(check => blockCycles(check.blockId))
            || [condition.then, condition.else].some(branch => branch && (branch.parts ?? [branch]).some(cycles));
    };
    return state.parts.some(cycles);
}

export function templateText(state, output = 0) {
    const library = new Map(state.blocks.map(block => [block.id, block.text]));
    return state.parts.map(part => {
        if (part.multiPrompt) return templateText({ ...state, parts: part.multiPrompt.variants[output] ?? [] });
        if (part.condition?.else !== undefined) {
            return [part.condition.then, part.condition.else].map(branch => templateText({ ...state, parts: branch.parts ?? [branch] }))
                .reduce((longest, text) => text.length > longest.length ? text : longest, "");
        }
        const fragment = part.condition?.then ?? part;
        if (fragment.parts) return templateText({ ...state, parts: fragment.parts });
        return "text" in fragment ? fragment.text : library.get(fragment.blockId) ?? "";
    }).join("");
}

export function normalizeState(raw = {}) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || (raw.version ?? 1) !== 1) {
        throw new Error("Unsupported Prompt Designer state.");
    }
    const defaults = defaultState();
    if (raw.cycleIndex !== undefined && (!Number.isSafeInteger(raw.cycleIndex) || raw.cycleIndex < -1)) {
        throw new Error("Invalid cycle position.");
    }
    const categories = raw.categories ?? defaults.categories;
    const categoryNames = new Set();
    if (!Array.isArray(categories) || categories.length > 128) throw new Error("The library supports up to 128 categories.");
    for (const category of categories) {
        if (!category || typeof category.name !== "string" || !category.name.trim() || category.name.length > 128
            || categoryNames.has(category.name.toLowerCase())
            || (category.color !== undefined && (typeof category.color !== "string" || !/^#[\da-f]{6}$/i.test(category.color)))) {
            throw new Error("Invalid or duplicate category.");
        }
        categoryNames.add(category.name.toLowerCase());
    }
    const blocks = raw.blocks ?? defaults.blocks;
    if (!Array.isArray(blocks) || blocks.length > 256) throw new Error("The block library supports up to 256 blocks.");
    const ids = new Set();
    for (const block of blocks) {
        if (!block || typeof block.id !== "string" || !block.id || ids.has(block.id)
            || typeof block.name !== "string" || typeof block.text !== "string"
            || block.id.length > 128 || block.name.length > 128 || block.text.length > MAX_PROMPT_CHARS) {
            throw new Error("Invalid or duplicate prompt block.");
        }
        if ((block.mode !== undefined && !["random", "cycle"].includes(block.mode))
            || (block.color !== undefined && (typeof block.color !== "string" || !/^#[\da-f]{6}$/i.test(block.color)))) {
            throw new Error("Invalid block sampling mode or color.");
        }
        if (block.category !== undefined && (typeof block.category !== "string" || block.category.length > 128)) {
            throw new Error("Invalid block category.");
        }
        ids.add(block.id);
    }
    const parts = raw.parts ?? (raw.blocks ? [] : defaults.parts);
    if (!Array.isArray(parts) || parts.length > 4096) throw new Error("The prompt contains too many fragments.");
    const validOutput = part => part && typeof part === "object" && Object.keys(part).length === 1
        && (typeof part.text === "string" || (typeof part.blockId === "string" && ids.has(part.blockId)));
    const validThen = part => validOutput(part) || (part && Object.keys(part).length === 1 && Array.isArray(part.parts)
        && part.parts.length <= 4096 && part.parts.every(validOutput));
    const validCheck = check => check && typeof check.blockId === "string" && (check.blockId === "" || ids.has(check.blockId))
        && typeof check.operator === "string" && (check.operator === "" || Object.hasOwn(CONDITION_OPERATORS, check.operator))
        && typeof check.value === "string" && check.value.length <= MAX_PROMPT_CHARS;
    for (const part of parts) {
        if (part && Object.keys(part).length === 1 && "multiPrompt" in part) {
            const multi = part.multiPrompt;
            if (!multi || typeof multi !== "object" || Object.keys(multi).length !== 1 || !Array.isArray(multi.variants)
                || multi.variants.length < 2 || multi.variants.length > MAX_PROMPT_OUTPUTS
                || multi.variants.some(variant => !Array.isArray(variant) || variant.length > 4096 || variant.some(item => !validOutput(item)))) {
                throw new Error(`Multi-prompt requires 2–${MAX_PROMPT_OUTPUTS} variants containing text and blocks.`);
            }
        } else if (part && Object.keys(part).length === 1 && "condition" in part) {
            const condition = part.condition;
            if (!condition || typeof condition !== "object"
                || Object.keys(condition).some(key => !["blockId", "operator", "value", "then", "else", "clauses"].includes(key))
                || !validCheck(condition) || !validThen(condition.then)
                || (Object.hasOwn(condition, "else") && !validThen(condition.else))
                || (Object.hasOwn(condition, "clauses") && (!Array.isArray(condition.clauses) || condition.clauses.length > 64
                    || condition.clauses.some(clause => !validCheck(clause) || Object.keys(clause).length !== 4
                        || !["and", "or"].includes(clause.join))))) {
                throw new Error("Invalid prompt condition.");
            }
        } else if (!validOutput(part)) {
            throw new Error("The prompt references a missing block or an invalid fragment.");
        }
    }
    const tabs = Array.isArray(raw.openTabs) ? [...new Set(raw.openTabs.filter(id => ids.has(id)))] : [];
    const state = {
        categories: categories.map(category => ({ name: category.name, ...(category.color === undefined ? {} : { color: category.color }) })),
        version: 1, blocks: blocks.map(block => ({ id: block.id, name: block.name, text: block.text,
            ...(block.category === undefined ? {} : { category: block.category }),
            ...(block.mode === undefined ? {} : { mode: block.mode }),
            ...(block.color === undefined ? {} : { color: block.color }) })),
        parts: mergeText(parts), seed: String(raw.seed ?? "0"),
        ...(raw.cycleIndex === undefined ? {} : { cycleIndex: raw.cycleIndex }),
        afterGenerate: raw.afterGenerate === "fixed" ? "fixed" : "randomize",
        openTabs: tabs, activeTab: tabs.includes(raw.activeTab) ? raw.activeTab : "prompt",
    };
    if (raw.promptTabs !== undefined) {
        if (!Array.isArray(raw.promptTabs) || !raw.promptTabs.length || raw.promptTabs.length > 128) throw new Error("Invalid prompt tabs.");
        const promptIds = new Set();
        state.promptTabs = raw.promptTabs.map(tab => {
            const details = tab?.details ?? {};
            if (!tab || typeof tab.id !== "string" || !/^[\da-f]{32}$/.test(tab.id) || promptIds.has(tab.id)
                || typeof tab.dirty !== "boolean" || typeof tab.seed !== "string" || tab.seed.length > 128
                || !["fixed", "randomize"].includes(tab.afterGenerate) || !Array.isArray(tab.parts)
                || !details || typeof details !== "object" || Array.isArray(details)
                || Object.keys(details).some(key => !["id", "revision", "name", "category", "color"].includes(key))
                || ["name", "category"].some(key => details[key] !== undefined && (typeof details[key] !== "string" || details[key].length > 128))
                || (details.color !== undefined && (typeof details.color !== "string" || !/^#[\da-f]{6}$/i.test(details.color)))
                || (details.id !== undefined && (typeof details.id !== "string" || !/^[\da-f]{32}$/.test(details.id)
                    || !Number.isSafeInteger(details.revision) || details.revision < 0))
                || (details.revision !== undefined && details.id === undefined)) throw new Error("Invalid prompt tab or template details.");
            if (tab.templateId !== undefined && (tab.templateId !== details.id || !(details.revision > 0))) {
                throw new Error("Invalid opened prompt template.");
            }
            promptIds.add(tab.id);
            const draft = normalizeState({ version: 1, categories, blocks, parts: tab.parts, seed: tab.seed,
                afterGenerate: tab.afterGenerate, cycleIndex: tab.cycleIndex });
            return { id: tab.id, parts: draft.parts, seed: draft.seed, afterGenerate: draft.afterGenerate,
                ...(draft.cycleIndex === undefined ? {} : { cycleIndex: draft.cycleIndex }),
                ...(tab.templateId === undefined ? {} : { templateId: tab.templateId }), details: { ...details }, dirty: tab.dirty };
        });
        if (!promptIds.has(raw.activePrompt)) throw new Error("The active prompt tab is missing.");
        state.activePrompt = raw.activePrompt;
        Object.assign(state.promptTabs.find(tab => tab.id === state.activePrompt), {
            parts: mergeText(state.parts), seed: state.seed, afterGenerate: state.afterGenerate,
            cycleIndex: state.cycleIndex,
        });
    }
    if (Array.from({ length: outputCount(state) }, (_, output) => templateText(state, output)).some(text => text.length > MAX_PROMPT_CHARS)
        || JSON.stringify(state).length > MAX_STATE_CHARS) {
        throw new Error("Prompt Designer state or expanded prompt is too large.");
    }
    return state;
}

export function removeBlock(state, id) {
    const block = state.blocks.find(item => item.id === id);
    if (!block) return;
    // Preserve authored content when its library entry is deleted.
    const keepText = part => part.blockId === id ? { text: block.text } : part;
    const preserveParts = parts => mergeText(parts.map(part => {
        if (part.multiPrompt) return { multiPrompt: { variants: part.multiPrompt.variants.map(variant => mergeText(variant.map(keepText))) } };
        if (!part.condition) return keepText(part);
        const condition = { ...part.condition };
        if (condition.blockId === id) condition.blockId = "";
        if (condition.clauses) condition.clauses = condition.clauses.map(clause => clause.blockId === id ? { ...clause, blockId: "" } : clause);
        for (const branch of ["then", "else"]) {
            const output = condition[branch];
            if (output) condition[branch] = output.parts ? { parts: mergeText(output.parts.map(keepText)) } : keepText(output);
        }
        return { condition };
    }));
    state.parts = preserveParts(state.parts);
    for (const tab of state.promptTabs ?? []) tab.parts = preserveParts(tab.parts);
    state.blocks = state.blocks.filter(item => item.id !== id);
    state.openTabs = state.openTabs.filter(tab => tab !== id);
    if (state.activeTab === id) state.activeTab = "prompt";
}

export function promptId() {
    // getRandomValues is available when ComfyUI is served over plain HTTP.
    const values = crypto.getRandomValues(new Uint32Array(4));
    return Array.from(values, value => value.toString(16).padStart(8, "0")).join("");
}

export function randomSeed() {
    const values = crypto.getRandomValues(new Uint32Array(2));
    return ((BigInt(values[0]) << 32n) | BigInt(values[1])).toString();
}

export class EditHistory {
    constructor() { this.undoStack = []; this.redoStack = []; this.group = null; }
    record(before, after, group = null, now = Date.now()) {
        if (!group || group !== this.group || now - this.time > 750) {
            this.undoStack.push({ before, after });
            if (this.undoStack.length > 50) this.undoStack.shift();
        } else this.undoStack.at(-1).after = after;
        this.group = group;
        this.time = now;
        this.redoStack.length = 0;
    }
    move(direction) {
        const from = direction === "undo" ? this.undoStack : this.redoStack;
        const to = direction === "undo" ? this.redoStack : this.undoStack;
        if (!from.length) return null;
        const command = from.pop();
        to.push(command);
        this.group = null;
        return command;
    }
}

// Keep only text and our atomic block references; pasted HTML never becomes workflow data.
export function readEditor(root) {
    const parts = [];
    const visit = node => {
        if (node.nodeType === 3) { parts.push({ text: node.textContent }); return; }
        if (node.nodeType !== 1) return;
        if (node.dataset?.pdCaretEnd) return;
        if (node.dataset?.blockId) { parts.push({ blockId: node.dataset.blockId }); return; }
        if (node.dataset?.condition) { parts.push({ condition: JSON.parse(node.dataset.condition) }); return; }
        if (node.dataset?.multiPrompt) { parts.push({ multiPrompt: JSON.parse(node.dataset.multiPrompt) }); return; }
        if (node.tagName === "BR") { parts.push({ text: "\n" }); return; }
        const line = node.tagName === "DIV" || node.tagName === "P";
        if (line && parts.length && !parts.at(-1).text?.endsWith("\n")) parts.push({ text: "\n" });
        for (const child of node.childNodes) visit(child);
        if (line && node.nextSibling && !parts.at(-1)?.text?.endsWith("\n")) parts.push({ text: "\n" });
    };
    for (const child of root.childNodes) visit(child);
    return mergeText(parts);
}
