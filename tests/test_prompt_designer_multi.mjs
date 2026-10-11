import assert from "node:assert/strict";
import test from "node:test";
import { normalizeState, readEditor, outputCount, templateText, removeBlock, MAX_PROMPT_CHARS, MAX_PROMPT_OUTPUTS, EditHistory } from "../web/prompt_designer/state.mjs";
import { syncPromptOutputs } from "../web/prompt_designer/outputs.mjs";
import { PromptDesignerWidget } from "../web/prompt_designer/widget.mjs";

import { sampleState as defaultState, text, dom, installDom, node } from "./helpers/prompt_designer_dom.mjs";

const multi = (...variants) => ({ multiPrompt: { variants } });
test("multi-prompt roundtrip preserves indexed text, blocks and all authored separators", () => {
    const state = normalizeState({ ...defaultState(), parts: [{ text: "common\n" },
        multi([{ text: "1girl, " }, { blockId: "clothing" }], [{ text: "1man\n\n" }, { blockId: "hair" }]), { text: "\nlast" }] });
    assert.deepEqual(normalizeState(JSON.parse(JSON.stringify(state))), state);
    assert.equal(outputCount(state), 2);
    assert.match(templateText(state, 0), /^common\n1girl, /);
    assert.match(templateText(state, 1), /^common\n1man\n\n/);
    const chip = { nodeType: 1, dataset: { multiPrompt: JSON.stringify(state.parts[1].multiPrompt) } };
    assert.deepEqual(readEditor({ childNodes: [text("common\n"), chip, text("\nlast")] }), state.parts);
});

test("validation rejects missing blocks, nested logic and oversized later outputs", () => {
    for (const part of [multi([]), multi(...Array(MAX_PROMPT_OUTPUTS + 1).fill([])), multi([{ blockId: "missing" }], []),
        multi([multi([], [])], []), multi([{ condition: {} }], []), multi("plain text", [])]) {
        assert.throws(() => normalizeState({ ...defaultState(), parts: [part] }));
    }
    assert.throws(() => normalizeState({ ...defaultState(), parts: [{ text: "prefix" }, multi([], [{ text: "x".repeat(MAX_PROMPT_CHARS) }])] }), /too large/);
});

test("deleting a card keeps every multi-prompt occurrence as its source text", () => {
    const state = normalizeState({ ...defaultState(), parts: [multi([{ blockId: "hair" }], [{ text: "wear " }, { blockId: "hair" }])] });
    const before = [templateText(state), templateText(state, 1)];
    removeBlock(state, "hair");
    assert.deepEqual([templateText(state), templateText(state, 1)], before);
    assert.deepEqual(normalizeState(JSON.parse(JSON.stringify(state))), state);
});

test("active output sockets grow, shrink and preserve restored links and existing slot identities", () => {
    const target = node(), first = target.outputs[0];
    const state = normalizeState({ ...defaultState(), parts: [multi([], [], [])] });
    syncPromptOutputs(target, state);
    assert.deepEqual(target.outputs.map(output => output.name), ["prompt", "prompt2", "prompt3"]);
    assert.equal(target.outputs[0], first);
    target.outputs[1].links = [42];
    const second = target.outputs[1];
    syncPromptOutputs(target, defaultState());
    assert.equal(target.outputs.length, 2);
    assert.equal(target.outputs[1], second);
    assert.deepEqual(second.links, [42]);
    second.links = [];
    syncPromptOutputs(target, defaultState());
    assert.equal(target.outputs.length, 1);
});

test("tools are below the main prompt and hint, and If inserts without typing an abbreviation", t => {
    installDom(t);
    t.mock.method(PromptDesignerWidget.prototype, "loadFromNode", function () { this.state = defaultState(); });
    const widget = new PromptDesignerWidget(node(), {});
    const tools = widget.main.childNodes.at(-1);
    assert.equal(tools.attributes.role, "toolbar");
    assert.deepEqual(tools.children.map(button => button.textContent), ["If", "Multi-prompt"]);
    assert.equal(widget.main.childNodes.at(-2).className, "vnccs-pd-hint");
    assert.equal(widget.main.childNodes.at(-3), widget.editor);
    t.mock.method(widget, "insertNode", chip => widget.editor.append(chip));
    t.mock.method(widget, "editCondition", () => {});
    widget.conditionRange = null;
    widget.ifTool.listeners.get("click")();
    const chip = widget.editor.childNodes[0];
    assert.equal(JSON.parse(chip.dataset.condition).blockId, "");
    assert.equal(widget.editCondition.mock.calls.length, 1);
});

test("oversized main input and repeated block edits retain the last valid workflow and recovery draft", t => {
    installDom(t);
    t.mock.method(PromptDesignerWidget.prototype, "loadFromNode", function () { this.state = defaultState(); });
    const widget = new PromptDesignerWidget(node(), {});
    t.after(() => widget.events.abort());
    widget.search.value = "";
    t.mock.method(widget, "schedulePreview", () => {});
    t.mock.method(widget, "scheduleBlockPreview", () => {});
    const writes = [];
    widget.documentStorage = { write(value) { writes.push(value); } };
    widget.render();
    widget.commit(null, false);
    const original = widget.node.widgets[0].value;
    widget.editor.replaceChildren(text("x".repeat(MAX_PROMPT_CHARS + 1)));
    widget.editor.listeners.get("input")({ isComposing: true });
    assert.equal(widget.node.widgets[0].value, original);
    assert.deepEqual(readEditor(widget.editor), JSON.parse(original).parts);
    assert.equal(writes.length, 1);
    assert.equal(widget.history.undoStack.length, 0);
    assert.match(widget.status.textContent, /Last valid edit was retained/);

    widget.state = normalizeState({ ...defaultState(), blocks: [{ id: "a", name: "Repeated", text: "coat" }],
        parts: [{ blockId: "a" }, { blockId: "a" }], openTabs: ["a"], activeTab: "a" });
    widget.render(); widget.commit(null, false);
    const linked = widget.node.widgets[0].value;
    widget.blockRaw.value = "x".repeat(40_000);
    widget.blockRaw.listeners.get("input")();
    assert.equal(widget.node.widgets[0].value, linked);
    assert.equal(widget.blockRaw.value, "x".repeat(40_000));
    assert.match(widget.status.textContent, /too large/);
    assert.equal(writes.length, 2);
    assert.deepEqual(normalizeState(JSON.parse(linked)), widget.state);
});

test("variant edits save immediately, keep the editor instance and restore ready chips", t => {
    installDom(t);
    t.mock.method(PromptDesignerWidget.prototype, "loadFromNode", function () { this.state = normalizeState({ ...defaultState(), parts: [multi([], [])] }); });
    const widget = new PromptDesignerWidget(node(), {});
    const chip = widget.multiPromptChip(widget.state.parts[0].multiPrompt);
    widget.editor.append(chip);
    t.mock.method(widget, "schedulePreview", () => {});
    widget.editMultiPrompt(chip);
    const editors = widget.multiRows.querySelectorAll(".vnccs-pd-variant-editor");
    editors[0].replaceChildren(text("1girl, wear "), widget.chip("clothing"));
    editors[1].replaceChildren(text("1man, wear "), widget.chip("hair"));
    editors[0].listeners.get("input")();
    assert.equal(widget.multiRows.querySelectorAll(".vnccs-pd-variant-editor")[0], editors[0]);
    assert.deepEqual(JSON.parse(widget.node.widgets[0].value).parts, widget.state.parts);
    assert.deepEqual(widget.state.parts[0].multiPrompt.variants, [[{ text: "1girl, wear " }, { blockId: "clothing" }], [{ text: "1man, wear " }, { blockId: "hair" }]]);
    assert.equal(widget.node.outputs.length, 2);
    widget.multiPanel.scrollTop = 120;
    editors[0].scrollTop = 40; editors[0].scrollLeft = 30;
    widget.addMultiVariant();
    assert.equal(widget.node.outputs.length, 3);
    assert.equal(widget.multiPanel.scrollTop, 120);
    assert.equal(widget.multiRows.querySelectorAll(".vnccs-pd-variant-editor")[0], editors[0]);
    assert.equal(editors[0].scrollTop, 40); assert.equal(editors[0].scrollLeft, 30);
    widget.node.outputs[2].links = [7];
    t.mock.method(widget, "setStatus", () => {});
    widget.removeMultiVariant(1);
    assert.equal(widget.state.parts[0].multiPrompt.variants.length, 3);
    assert.match(widget.setStatus.mock.calls.at(-1).arguments[0], /Disconnect/);
    widget.node.outputs[2].links = [];
    widget.removeMultiVariant(2);
    assert.equal(widget.state.parts[0].multiPrompt.variants.length, 2);
    assert.equal(widget.node.outputs.length, 2);
});

test("preview and copy source switch outputs without changing workflow data or scroll", t => {
    installDom(t);
    const widget = Object.create(PromptDesignerWidget.prototype);
    widget.output = dom("pre"); widget.outputSelect = dom("select"); widget.state = defaultState();
    const saved = JSON.stringify(widget.state);
    widget.output.scrollTop = 35;
    widget.showResolvedPrompts(["first\nready", "second\nready"]);
    assert.equal(widget.output.textContent, "first\nready");
    widget.showResolvedPrompts(widget.resolvedPrompts, 1);
    assert.equal(widget.output.textContent, "second\nready");
    widget.output.scrollTop = 80;
    widget.showResolvedPrompts(widget.resolvedPrompts, 0);
    assert.equal(widget.output.scrollTop, 35);
    widget.showResolvedPrompts(widget.resolvedPrompts, 1);
    assert.equal(widget.output.scrollTop, 80);
    assert.equal(JSON.stringify(widget.state), saved);
    widget.showResolvedPrompts(["only output"]);
    assert.equal(widget.outputSelect.hidden, true);
    assert.equal(widget.output.textContent, "only output");
});

test("inspector starts hidden, owns the editors and restores each selection's scroll", t => {
    installDom(t);
    t.mock.method(PromptDesignerWidget.prototype, "loadFromNode", function () { this.state = defaultState(); });
    const widget = new PromptDesignerWidget(node(), {});
    assert.equal(widget.inspector.hidden, true);
    assert.equal(widget.inspector.parentNode, widget.workspace);
    assert.equal(widget.conditionPanel.parentNode, widget.inspector);
    assert.equal(widget.multiPanel.parentNode, widget.inspector);
    assert.equal(widget.blockSearch.parentNode.parentNode, widget.cardPanel);
    assert.equal(widget.blockColor.type, "color");
    const condition = {}, multi = {};
    widget.showInspector(widget.conditionPanel, condition, "Inspector · If");
    widget.conditionPanel.scrollTop = 125; widget.conditionPanel.scrollLeft = 15;
    widget.showInspector(widget.multiPanel, multi, "Inspector · Multi-prompt");
    assert.equal(widget.conditionPanel.hidden, true);
    assert.equal(widget.multiPanel.hidden, false);
    widget.multiPanel.scrollTop = 70;
    widget.hideInspector();
    assert.equal(widget.inspector.hidden, true);
    widget.showInspector(widget.conditionPanel, condition, "Inspector · If");
    assert.equal(widget.conditionPanel.scrollTop, 125);
    assert.equal(widget.conditionPanel.scrollLeft, 15);
    widget.showInspector(widget.multiPanel, multi, "Inspector · Multi-prompt");
    assert.equal(widget.multiPanel.scrollTop, 70);
    for (const [panel, close] of [[widget.conditionPanel, "closeCondition"], [widget.multiPanel, "closeMultiPrompt"]]) {
        let top = 0;
        Object.defineProperty(panel, "scrollTop", { get() { return this.hidden ? 0 : top; }, set(value) { top = value; } });
        widget.showInspector(panel, panel, "Inspector");
        panel.scrollTop = 155;
        widget[close](false);
        widget.showInspector(panel, panel, "Inspector");
        assert.equal(panel.scrollTop, 155, "Capture scroll before hiding the panel");
    }
});

test("card mode and color persist immediately in workflow and recovery drafts while rewriting source markers and retaining scroll", t => {
    installDom(t);
    t.mock.method(PromptDesignerWidget.prototype, "loadFromNode", function () { this.state = defaultState(); });
    const widget = new PromptDesignerWidget(node(), {});
    for (const method of ["renderTabs", "markLibrarySelection", "scheduleBlockPreview", "schedulePreview"]) t.mock.method(widget, method, () => {});
    widget.state.openTabs = ["artists"]; widget.state.activeTab = "artists";
    const source = widget.activeBlock().text;
    const chip = widget.chip("artists"), second = widget.chip("artists");
    widget.editor.append(chip); widget.multiRows.append(second);
    widget.showTab();
    assert.equal(widget.inspector.hidden, false);
    assert.equal(widget.cardPanel.hidden, false);
    widget.cardPanel.scrollTop = 70; widget.variants.scrollTop = 300;
    const drafts = [];
    widget.documentStorage = { write(value) { drafts.push(JSON.parse(value)); } };
    widget.blockMode.value = "cycle"; widget.blockMode.listeners.get("change")();
    widget.blockColor.value = "#f28ab2"; widget.blockColor.listeners.get("input")();
    const saved = JSON.parse(widget.node.widgets[0].value).blocks[0];
    assert.deepEqual(saved, { id: "artists", name: "Artists", text: source.replace("{~", "{@"), mode: "cycle", color: "#f28ab2" });
    assert.deepEqual(drafts.at(-1).blocks[0], saved);
    assert.deepEqual(normalizeState(JSON.parse(JSON.stringify(widget.state))), widget.state);
    assert.equal(chip.style["--pd-chip-color"], "#f28ab2");
    assert.equal(second.style["--pd-chip-color"], "#f28ab2");
    assert.equal(widget.chip("artists").style["--pd-chip-color"], "#f28ab2");
    assert.equal(widget.cardPanel.scrollTop, 70); assert.equal(widget.variants.scrollTop, 300);
    widget.state.activeTab = "prompt"; widget.showTab();
    assert.equal(widget.inspector.hidden, true);
    widget.state.activeTab = "artists"; widget.showTab();
    assert.equal(widget.blockMode.value, "cycle"); assert.equal(widget.blockColor.value, "#f28ab2");
    assert.equal(widget.cardPanel.scrollTop, 70);
});

test("condition inspector saves individual field edits before Apply or reload", t => {
    installDom(t);
    t.mock.method(PromptDesignerWidget.prototype, "loadFromNode", function () { this.state = defaultState(); });
    const widget = new PromptDesignerWidget(node(), {});
    t.mock.method(widget, "schedulePreview", () => {});
    const chip = widget.conditionChip({ blockId: "artists", operator: "equals", value: "", then: { text: "" } });
    widget.editor.append(chip);
    widget.editCondition(chip);
    assert.equal(widget.inspectorPanel, widget.conditionPanel);
    widget.conditionValue.value = "ink";
    widget.conditionValue.listeners.get("input")();
    widget.conditionOutput.textContent = "beautiful";
    widget.conditionOutput.listeners.get("input")();
    const saved = JSON.parse(widget.node.widgets[0].value);
    assert.equal(saved.parts[0].condition.value, "ink");
    assert.deepEqual(saved.parts[0].condition.then, { text: "beautiful" });
    widget.closeInspector();
    assert.equal(widget.inspector.hidden, true);
    widget.editCondition(chip);
    assert.equal(widget.conditionValue.value, "ink");
    assert.equal(widget.conditionOutput.textContent, "beautiful");
    widget.editMultiPrompt(widget.multiPromptChip({ variants: [[], []] }));
    assert.equal(widget.inspectorPanel, widget.multiPanel);
    assert.equal(widget.conditionPanel.hidden, true);
});

test("old cards keep their schema while malformed inspector preferences are rejected", () => {
    assert.deepEqual(normalizeState(defaultState()).blocks, defaultState().blocks);
    for (const extra of [{ mode: "bad" }, { mode: null }, { color: "red" }, { color: "#abc" }, { color: "#ffffff;display:none" }]) {
        assert.throws(() => normalizeState({ ...defaultState(), blocks: [{ ...defaultState().blocks[0], ...extra }] }), /mode or color/);
    }
});

test("saved cards appear in the existing library and retain preferences when opened", async t => {
    installDom(t);
    t.mock.method(PromptDesignerWidget.prototype, "loadFromNode", function () { this.state = defaultState(); });
    const card = { ...defaultState().blocks[0], mode: "cycle", color: "#ff8fa3" };
    const widget = new PromptDesignerWidget(node(), {
        fetchApi: async () => ({ ok: true, json: async () => ({ cards: [card], total: 1 }) }),
    });
    widget.search.value = "";
    t.mock.method(widget, "schedulePreview", () => {});
    t.mock.method(widget, "openBlock", () => {});
    await widget.loadLibraryCards();
    assert.equal(widget.list.children.length, 5);
    widget.list.children.at(-1).listeners.get("click")();
    const imported = widget.state.blocks.at(-1);
    assert.notEqual(imported.id, card.id);
    assert.deepEqual({ ...imported, id: card.id }, card);
    assert.deepEqual(JSON.parse(widget.node.widgets[0].value).blocks.at(-1), imported);
    widget.list.children.at(-1).listeners.get("click")();
    assert.equal(widget.state.blocks.length, 5);
    assert.equal(widget.openBlock.mock.calls.at(-1).arguments[0], imported.id);
});

test("default cards share the existing list without sections or overwriting authored cards", async t => {
    installDom(t);
    t.mock.method(PromptDesignerWidget.prototype, "loadFromNode", function () { this.state = defaultState(); });
    const requests = [];
    let source = "{~bundled first|bundled second}";
    const widget = new PromptDesignerWidget(node(), {
        fetchApi: async url => {
            requests.push(url);
            return { ok: true, json: async () => ({ cards: [{ id: "artists", name: "Artists", text: source, color: "#ff8fa3" }], total: 1 }) };
        },
    });
    widget.search.value = "";
    for (const method of ["schedulePreview", "openBlock"]) t.mock.method(widget, method, () => {});
    const library = widget.library;
    assert.equal(library.children.filter(child => child.tagName === "DETAILS").length, 0);
    assert.deepEqual(library.children.map(child => child.tagName), ["DIV", "DIV", "DIV", "INPUT", "DIV", "DIV", "BUTTON", "DIV"]);
    assert.equal(library.children.at(-2).textContent, "+ New block");
    const original = JSON.stringify(widget.state);
    widget.list.scrollTop = 100;
    await widget.loadLibraryCards(true);
    assert.match(requests[0], /\/defaults\?/);
    assert.equal(widget.list.scrollTop, 100);
    assert.equal(JSON.stringify(widget.state), original);
    assert.equal(widget.list.children.length, 5);
    widget.list.children.at(-1).listeners.get("click")();
    const imported = widget.state.blocks.at(-1);
    assert.notEqual(imported.id, "artists");
    assert.equal(widget.state.blocks[0].text, defaultState().blocks[0].text);
    assert.equal(imported.text, source);
    imported.text = "user edited this copy";
    widget.commit();
    const saved = widget.node.widgets[0].value;
    source = "{~updated package|new default}";
    await widget.loadLibraryCards(true);
    assert.equal(widget.node.widgets[0].value, saved);
    assert.equal(widget.state.blocks.at(-1).text, "user edited this copy");
    assert.equal(widget.state.blocks.length, 5);
});

test("the single library loads later pages, filters every source and drags a ready card reference", async t => {
    installDom(t);
    t.mock.method(PromptDesignerWidget.prototype, "loadFromNode", function () { this.state = defaultState(); });
    const requests = [];
    const widget = new PromptDesignerWidget(node(), { fetchApi: async url => {
        requests.push(url);
        const offset = Number(new URL(url, "https://comfy.example").searchParams.get("offset"));
        return { ok: true, json: async () => ({ cards: [{ id: "external", name: offset ? "Saved second" : "Saved first", text: "text" }], total: 2 }) };
    } });
    t.mock.method(widget, "schedulePreview", () => {});
    widget.search.value = "Saved";
    const original = JSON.stringify(widget.state);
    await widget.loadLibraryCards();
    assert.deepEqual(requests.map(url => new URL(url, "https://comfy.example").searchParams.get("offset")), ["0", "1"]);
    assert.equal(JSON.stringify(widget.state), original);
    assert.equal(widget.list.children.filter(row => !row.hidden).length, 2);
    const transferred = new Map();
    widget.list.children.at(-1).listeners.get("dragstart")({ stopPropagation() {}, dataTransfer: { setData(key, value) { transferred.set(key, value); } } });
    const selected = widget.state.blocks.at(-1);
    assert.equal(selected.name, "Saved second");
    assert.equal(transferred.get("application/x-vnccs-prompt-block"), selected.id);
    assert.equal(transferred.get("text/plain"), selected.text);
    assert.deepEqual(JSON.parse(widget.node.widgets[0].value).blocks.at(-1), selected);
});
