import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { normalizeState, templateText, mergeText, removeBlock, EditHistory, readEditor, hasCycle } from "../web/prompt_designer/state.mjs";
import { sampleState as defaultState, dom, installDom, node } from "./helpers/prompt_designer_dom.mjs";
import { PromptDesignerWidget } from "../web/prompt_designer/widget.mjs";

test("widget construction and new blocks work without secure-context randomUUID", t => {
    const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
    const crypto = globalThis.crypto;
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: {
        getRandomValues: values => crypto.getRandomValues(values),
    } });
    installDom(t);
    t.after(() => {
        Object.defineProperty(globalThis, "crypto", cryptoDescriptor);
    });
    t.mock.method(PromptDesignerWidget.prototype, "loadFromNode", function () { this.state = defaultState(); });
    const first = new PromptDesignerWidget(node(), {});
    const second = new PromptDesignerWidget(node(), {});
    assert.equal(new Set([first.main.id, first.blockDoc.id, second.main.id, second.blockDoc.id]).size, 4);
    t.mock.method(first, "insertCondition", () => {});
    let prevented = false;
    const tab = { key: "Tab", target: first.editor, stopPropagation() {}, preventDefault() { prevented = true; } };
    first.conditionSuggestion.hidden = false;
    first.container.listeners.get("keydown")(tab);
    assert.equal(prevented, true);
    assert.equal(first.insertCondition.mock.calls.length, 1);
    first.conditionSuggestion.hidden = true;
    prevented = false;
    first.container.listeners.get("keydown")(tab);
    assert.equal(prevented, false);
    assert.equal(first.insertCondition.mock.calls.length, 1);
    t.mock.method(first, "commit", () => {});
    t.mock.method(first, "renderLibrary", () => {});
    t.mock.method(first, "openBlock", () => {});
    first.newBlock();
    first.newBlock();
    assert.equal(new Set(first.state.blocks.map(block => block.id)).size, first.state.blocks.length);
    assert.deepEqual(normalizeState(JSON.parse(JSON.stringify(first.state))), first.state);
});

test("prompt chips display names while keeping shared block text and references", t => {
    installDom(t);
    t.mock.method(PromptDesignerWidget.prototype, "loadFromNode", function () { this.state = defaultState(); });
    const widget = new PromptDesignerWidget(node(), {});
    const chips = [widget.chip("artists"), widget.chip("artists"), widget.chip("hair")];
    widget.editor = { childNodes: chips, querySelectorAll: selector => selector === "[data-block-id]" ? chips : [] };
    assert.deepEqual(chips.map(chip => chip.textContent), ["Artists", "Artists", "Hair"]);
    assert.equal(chips[0].contentEditable, "false");
    assert.equal(chips[0].tabIndex, 0);
    assert.equal(chips[0].attributes.role, "button");
    const block = widget.state.blocks.find(block => block.id === "artists");
    block.text = "{~ink|watercolor}";
    widget.updateChips(block);
    assert.equal(chips[0].textContent, "Artists");
    block.name = "Art style";
    widget.updateChips(block);
    assert.deepEqual(chips.map(chip => chip.textContent), ["Art style", "Art style", "Hair"]);
    assert.equal(chips[0].attributes["aria-label"], "Edit block: Art style");
    assert.equal(chips[0].title, "Click to select. Double-click or press Enter to edit Art style. Drag to move.");
    assert.deepEqual(readEditor(widget.editor), [{ blockId: "artists" }, { blockId: "artists" }, { blockId: "hair" }]);
    assert.match(templateText(normalizeState(JSON.parse(JSON.stringify(widget.state)))), /\{~ink\|watercolor\}/);
    block.name = "";
    widget.updateChips(block);
    assert.equal(chips[0].textContent, "Untitled block");
    assert.equal(widget.chip("artists").textContent, "Untitled block");
});

test("editable variants retain source offsets, indexes, scroll and stale/error response protection", async t => {
    installDom(t);
    t.mock.method(PromptDesignerWidget.prototype, "loadFromNode", function () { this.state = defaultState(); });
    const widget = new PromptDesignerWidget(node(), {});
    t.after(() => widget.events.abort());
    widget.state.activeTab = "artists";
    widget.scroll.set("artists", { previewTop: 300, previewLeft: 20 });
    widget.blockView.value = "variants";
    widget.blockSearch.value = "";
    widget.activeBlock().text = "{~coat|INK, ink, Ink|prefix .* suffix|<script>inert</script>}";
    const saved = JSON.stringify(widget.state);
    widget.renderBlockVariants();
    assert.equal(widget.variants.children.length, 5, "four editable variants and one blank row");
    assert.equal(widget.variants.children[0].children[1].contentEditable, "true");
    assert.equal(widget.variants.scrollTop, 300);
    assert.equal(widget.variants.scrollLeft, 20);
    widget.blockSearch.value = "ink"; widget.renderBlockVariants();
    assert.equal(widget.variants.children.length, 1);
    assert.equal(widget.variants.children[0].children[0].textContent, "2");
    assert.deepEqual(widget.variants.querySelectorAll(".vnccs-pd-match").map(mark => mark.textContent), ["INK", "ink", "Ink"]);
    assert.equal(widget.blockStatus.textContent, "1 of 4 variants match");
    widget.blockSearch.value = ".*"; widget.renderBlockVariants();
    assert.equal(widget.variants.children[0].children[0].textContent, "3");
    widget.blockSearch.value = "<script>"; widget.renderBlockVariants();
    assert.equal(widget.variants.querySelectorAll(".vnccs-pd-match")[0].textContent, "<script>");
    widget.blockSearch.value = "missing"; widget.renderBlockVariants();
    assert.equal(widget.variants.children.length, 0);
    assert.match(widget.blockStatus.textContent, /No matches/);
    widget.blockSearch.value = ""; widget.renderBlockVariants();
    assert.equal(widget.variants.children.length, 5);
    assert.equal(widget.variants.scrollTop, 300);
    assert.equal(JSON.stringify(widget.state), saved);
    const rows = widget.variants.children;
    let finish;
    widget.api.fetchApi = () => new Promise(resolve => { finish = resolve; });
    const pending = widget.previewBlock(); widget.blockRevision++;
    finish({ ok: true, json: async () => ({ variants: ["stale"] }) }); await pending;
    assert.deepEqual(widget.variants.children, rows);
    widget.api.fetchApi = async () => ({ ok: false, json: async () => ({ error: "Invalid syntax" }) });
    await widget.previewBlock();
    assert.equal(widget.blockStatus.textContent, "Invalid syntax");
    assert.deepEqual(widget.variants.children, rows, "parser errors must not erase the editable draft");
});

test("block preview scheduling cancels old work and disposal prevents late updates", t => {
    installDom(t);
    t.mock.method(PromptDesignerWidget.prototype, "loadFromNode", function () { this.state = defaultState(); });
    const widget = new PromptDesignerWidget(node(), {});
    widget.state.activeTab = "artists";
    widget.blockRequest = new AbortController();
    t.mock.method(globalThis, "setTimeout", () => 1);
    t.mock.method(globalThis, "clearTimeout", () => {});
    widget.scheduleBlockPreview();
    assert.equal(widget.blockRequest.signal.aborted, true);
    assert.equal(widget.blockRevision, 1);
    widget.disposed = true;
    widget.scheduleBlockPreview();
    assert.equal(widget.blockRevision, 2);
    assert.equal(widget.blockStatus.textContent, "3 variants");
});

test("API export and workflow serialization keep the seed; only queue preparation randomizes it", () => {
    const widget = Object.create(PromptDesignerWidget.prototype);
    widget.state = defaultState();
    widget.seed = { value: "0" };
    widget.revision = 0;
    widget.commit = () => { widget.revision++; };
    widget.persist = () => JSON.stringify(widget.state);
    const snapshot = widget.serializeForPrompt();
    assert.equal(widget.serializeForPrompt(), snapshot);
    assert.equal(widget.state.seed, "0");
    widget.prepareForQueue();
    assert.notEqual(widget.state.seed, "0");
    assert.equal(widget.serializeForPrompt(), widget.persist());
    const queuedSeed = widget.state.seed;
    widget.state.afterGenerate = "fixed";
    widget.prepareForQueue();
    assert.equal(widget.state.seed, queuedSeed);
    assert.equal(widget.state.cycleIndex, undefined, "random-only workflows keep their existing serialized state");
});

test("cycle position advances only for queue or shuffle and survives workflow restoration with Keep seed", t => {
    installDom(t);
    t.mock.method(PromptDesignerWidget.prototype, "loadFromNode", function () { this.state = defaultState(); });
    const widget = new PromptDesignerWidget(node(), {});
    t.after(() => widget.events.abort());
    t.mock.method(widget, "schedulePreview", () => {});
    widget.state.afterGenerate = "fixed";
    widget.state.blocks.find(block => block.id === "artists").mode = "cycle";
    widget.state.parts = [{ blockId: "artists" }];
    widget.commit(null, false);
    const raw = widget.serializeForPrompt();
    assert.equal(widget.serializeForPrompt(), raw);
    assert.equal(widget.state.cycleIndex, undefined);
    for (const index of [0, 1, 2]) {
        const queued = widget.prepareForQueue();
        assert.equal(widget.state.cycleIndex, index);
        assert.equal(widget.state.seed, "0");
        assert.equal(normalizeState(JSON.parse(queued)).cycleIndex, index);
        assert.equal(widget.serializeForPrompt(), queued);
    }
    widget.state = normalizeState(JSON.parse(widget.node.widgets[0].value));
    widget.container.querySelector(".vnccs-pd-shuffle").listeners.get("click")();
    assert.equal(widget.state.cycleIndex, 3);
    assert.equal(JSON.parse(widget.node.widgets[0].value).cycleIndex, 3);
    widget.prepareForQueue();
    assert.equal(widget.state.cycleIndex, 4);
});

test("cycle detection follows referenced text, multi outputs and If branches, and ignores unused or random cards", () => {
    const state = defaultState();
    state.blocks[0].text = "{@red|blue}";
    state.parts = [{ text: "plain" }];
    assert.equal(hasCycle(state), false);
    for (const part of [{ text: "{@red|blue}" }, { blockId: state.blocks[0].id },
        { multiPrompt: { variants: [[{ blockId: state.blocks[0].id }], []] } },
        { condition: { blockId: state.blocks[0].id, operator: "equals", value: "red", then: { text: "ok" } } },
        { condition: { blockId: "hair", operator: "equals", value: "white", then: { parts: [{ blockId: state.blocks[0].id }] } } }]) {
        state.parts = [part];
        assert.equal(hasCycle(state), true);
    }
    state.parts = [{ blockId: state.blocks[0].id }];
    state.blocks[0].mode = "random";
    assert.equal(hasCycle(state), false);
    state.blocks[0].mode = "cycle";
    state.blocks[0].text = "plain";
    assert.equal(hasCycle(state), true);
    for (const cycleIndex of [true, "1", 0.5, null, -2, Number.MAX_SAFE_INTEGER + 1]) {
        assert.throws(() => normalizeState({ ...state, cycleIndex }), /cycle position/);
    }
    for (const cycleIndex of [-1, 0, Number.MAX_SAFE_INTEGER]) {
        assert.equal(normalizeState({ ...state, cycleIndex }).cycleIndex, cycleIndex);
    }
});

test("workflow roundtrip preserves authored text, shared blocks, seed precision and unique tabs", () => {
    const state = defaultState();
    state.seed = "18446744073709551615";
    state.openTabs = ["clothing", "clothing", "missing"];
    state.activeTab = "clothing";
    const restored = normalizeState(JSON.parse(JSON.stringify(state)));
    assert.equal(templateText(restored), templateText(state));
    assert.equal(restored.seed, "18446744073709551615");
    assert.deepEqual(restored.openTabs, ["clothing"]);
    assert.equal(restored.activeTab, "clothing");
    restored.blocks.find(block => block.id === "clothing").text = "jacket";
    assert.match(templateText(restored), /wear: jacket/);
});

test("deleting a library block preserves all its authored text as ordinary fragments", () => {
    const state = defaultState();
    state.parts.push({ blockId: "clothing" });
    state.openTabs = ["clothing"];
    state.activeTab = "clothing";
    const original = templateText(state);
    removeBlock(state, "clothing");
    assert.equal(templateText(state), original);
    assert.equal(state.parts.some(part => part.blockId === "clothing"), false);
    assert.equal(state.activeTab, "prompt");
    assert.deepEqual(state.openTabs, []);
});

test("malformed and future state fail restoration rather than discarding authored data", () => {
    for (const raw of [null, [], { version: 2 }, { blocks: "bad" }, { blocks: [], parts: [{ blockId: "missing" }] }]) {
        assert.throws(() => normalizeState(raw));
    }
    assert.deepEqual(normalizeState({ blocks: [], parts: [] }).parts, []);
});

test("conditions survive roundtrip and deleting referenced blocks clears checks without erasing logic", () => {
    const state = defaultState();
    const condition = { blockId: "hair", operator: "contains", value: "white", then: { blockId: "clothing" } };
    state.parts.push({ condition });
    const restored = normalizeState(JSON.parse(JSON.stringify(state)));
    assert.deepEqual(restored.parts.at(-1), { condition });
    assert.notEqual(restored.parts.at(-1).condition, condition);
    assert.notEqual(restored.parts.at(-1).condition.then, condition.then);
    const chip = { nodeType: 1, dataset: { condition: JSON.stringify(condition) }, childNodes: [] };
    assert.deepEqual(readEditor({ childNodes: [chip] }), [{ condition }]);
    removeBlock(restored, "hair");
    assert.equal(restored.parts.at(-1).condition.blockId, "");
    removeBlock(restored, "clothing");
    assert.deepEqual(restored.parts.at(-1).condition.then, { text: state.blocks.find(block => block.id === "clothing").text });
    assert.deepEqual(normalizeState(JSON.parse(JSON.stringify(restored))), restored);
    for (const invalid of [
        { ...condition, blockId: "missing" }, { ...condition, operator: "eval" }, { ...condition, operator: ["contains"] },
        { ...condition, value: 3 }, { ...condition, then: { blockId: "missing" } },
        { ...condition, then: { condition } }, { ...condition, extra: true },
    ]) assert.throws(() => normalizeState({ ...state, parts: [{ condition: invalid }] }), /Invalid prompt condition/);
});

test("typing an isolated if offers completion and Tab insertion replaces only that keyword", t => {
    const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
    const text = { nodeType: 3, textContent: "prefix, if suffix", parentElement: { closest: () => null } };
    const range = {
        startContainer: text, startOffset: 10,
        cloneRange() { return { ...this }; },
        setStart(node, offset) { this.startContainer = node; this.startOffset = offset; },
    };
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
        getSelection: () => ({ rangeCount: 1, isCollapsed: true, anchorNode: text, getRangeAt: () => range }),
    } });
    t.after(() => {
        if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor);
        else delete globalThis.window;
    });
    const widget = Object.create(PromptDesignerWidget.prototype);
    widget.state = defaultState();
    widget.editor = { contains: node => node === text };
    widget.conditionSuggestion = {};
    widget.updateConditionSuggestion();
    assert.equal(widget.conditionSuggestion.hidden, false);
    assert.equal(widget.conditionRange.startOffset, 8);
    const chip = {};
    t.mock.method(widget, "conditionChip", condition => { assert.equal(condition.blockId, ""); return chip; });
    t.mock.method(widget, "selectRange", selected => { assert.equal(selected.startOffset, 8); });
    t.mock.method(widget, "insertNode", inserted => { assert.equal(inserted, chip); });
    t.mock.method(widget, "editCondition", edited => { assert.equal(edited, chip); });
    widget.insertCondition();
    assert.equal(widget.conditionSuggestion.hidden, true);
    assert.equal(widget.conditionRange, null);
    text.textContent = "motif";
    range.startOffset = 5;
    widget.updateConditionSuggestion();
    assert.equal(widget.conditionSuggestion.hidden, true);
});

test("condition inspector saves mixed outputs and rejects invalid references without replacing state", t => {
    installDom(t);
    t.mock.method(PromptDesignerWidget.prototype, "loadFromNode", function () { this.state = defaultState(); });
    const widget = new PromptDesignerWidget(node(), {});
    t.mock.method(widget, "schedulePreview", () => {});
    const condition = { blockId: "hair", operator: "contains", value: "white", then: { text: "beautiful" } };
    const chip = widget.conditionChip(condition);
    widget.editor.replaceChildren(chip);
    widget.editCondition(chip);
    widget.conditionOutput.replaceChildren(document.createTextNode("wear "), widget.chip("clothing"));
    widget.conditionElseOutput.textContent = "other";
    widget.applyCondition(false);
    assert.deepEqual(widget.state.parts[0].condition.then, { parts: [{ text: "wear " }, { blockId: "clothing" }] });
    assert.deepEqual(widget.state.parts[0].condition.else, { text: "other" });
    const saved = JSON.stringify(widget.state), encoded = chip.dataset.condition;
    widget.conditionSource.value = "missing"; widget.applyCondition(false);
    assert.equal(JSON.stringify(widget.state), saved);
    assert.equal(chip.dataset.condition, encoded);
    assert.equal(widget.status.hidden, false);
});

test("history groups typing, branches after undo and retains one entry per discrete edit", () => {
    const history = new EditHistory();
    history.record("a", "ab", "prompt", 0);
    history.record("ab", "abc", "prompt", 100);
    history.record("abc", "abcd", "block:1", 200);
    assert.deepEqual(history.move("undo"), { before: "abc", after: "abcd" });
    assert.deepEqual(history.move("undo"), { before: "a", after: "abc" });
    assert.deepEqual(history.move("redo"), { before: "a", after: "abc" });
    history.record("abc", "new edit", "prompt", 300);
    assert.equal(history.move("redo"), null);
});

test("fragment normalization never changes manually authored separators", () => {
    assert.deepEqual(mergeText([{ text: "a," }, { text: "\n" }, { blockId: "b" }, { text: "" }, { text: " tail" }]),
        [{ text: "a,\n" }, { blockId: "b" }, { text: " tail" }]);
});

test("editor serialization keeps links atomic and pasted text inert", () => {
    const text = value => ({ nodeType: 3, textContent: value });
    const chip = { nodeType: 1, tagName: "SPAN", dataset: { blockId: "clothing" }, childNodes: [text("must not become plain text")] };
    const root = { childNodes: [text("wear: "), chip, { nodeType: 1, tagName: "BR" }, text("<script>inert</script>")] };
    assert.deepEqual(readEditor(root), [{ text: "wear: " }, { blockId: "clothing" }, { text: "\n<script>inert</script>" }]);
});

test("widget saves from input, ignores stale previews, cleans listeners and preserves lifecycle callbacks", async () => {
    const widget = await readFile(new URL("../web/prompt_designer/widget.mjs", import.meta.url), "utf8");
    const entry = await readFile(new URL("../web/vnccs_prompt_designer.js", import.meta.url), "utf8");
    assert.match(widget, /this\.on\(this\.editor, "input"/);
    assert.match(widget, /this\.on\(this\.blockRaw, "input"/);
    assert.match(widget, /widget\.value = value/);
    assert.match(widget, /revision !== this\.revision/);
    assert.match(widget, /this\.events\.abort\(\)/);
    assert.match(widget, /this\.selects\.disconnect\(\)/);
    assert.match(widget, /this\.request\?\.abort\(\)/);
    assert.match(entry, /serialize: false, hideOnZoom: false/);
    for (const hook of ["created", "configured", "resized", "serialized", "removed"]) {
        assert.ok(entry.includes(`${hook}?.apply(this, arguments)`), hook);
    }
    assert.doesNotMatch(entry, /prototype\.onExecuted\s*=/, "execution callbacks remain owned by the node");
    assert.doesNotMatch(widget, /Assembly order|Max prompts|innerHTML/);
});
