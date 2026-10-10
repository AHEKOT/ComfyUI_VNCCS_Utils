import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { defaultState, normalizeState, readEditor } from "../web/prompt_designer/state.mjs";
import { blockRows, blockSourceMode } from "../web/prompt_designer/block_source.mjs";
import { PromptDesignerWidget } from "../web/prompt_designer/widget.mjs";
import { sampleState, installDom, node, text, dom } from "./helpers/prompt_designer_dom.mjs";

function setup(t) {
    const selection = installDom(t);
    t.mock.method(PromptDesignerWidget.prototype, "loadFromNode", function () { this.state = sampleState(); });
    const widget = new PromptDesignerWidget(node(), {});
    t.mock.method(widget, "schedulePreview", () => {});
    t.mock.method(widget, "scheduleBlockPreview", () => {});
    widget.render(); widget.commit(null, false);
    t.after(() => widget.events.abort());
    return { widget, selection };
}
function transfer() {
    const values = new Map();
    return { get types() { return [...values.keys()]; }, setData(key, value) { values.set(key, value); }, getData(key) { return values.get(key) ?? ""; } };
}
function emit(target, type, event = {}) { target.listeners.get(type)?.(event); return event; }
function bubble(target, type, event = {}) {
    event.target = target;
    const path = [];
    for (let current = target; current; current = current.parentNode) path.push(current);
    for (const current of path) {
        emit(current, type, event);
        if (event.stopped) break;
    }
    return event;
}
function insertIf(widget) {
    const chip = widget.conditionChip({ blockId: "", operator: "", value: "", then: { text: "" }, else: { text: "" } });
    widget.editor.replaceChildren(chip); widget.savePromptEditor(widget.editor);
    return chip;
}

test("paste stays inside Prompt Designer while plain text and native fields remain editable", t => {
    const { widget } = setup(t);
    document.append(document.body); document.body.append(widget.container);
    const graphPaste = t.mock.fn(), graphKey = t.mock.fn();
    document.addEventListener("paste", graphPaste); document.addEventListener("keydown", graphKey);
    const clipboardData = transfer(); clipboardData.setData("text/plain", "pasted <b>text</b>\nsecond line");
    widget.editor.replaceChildren(); widget.savePromptEditor(widget.editor);
    const pasted = bubble(widget.editor, "paste", { clipboardData });
    assert.equal(pasted.defaultPrevented, true);
    assert.equal(widget.editor.textContent, clipboardData.getData("text/plain"));
    assert.deepEqual(JSON.parse(widget.node.widgets[0].value).parts, [{ text: clipboardData.getData("text/plain") }]);
    assert.equal(graphPaste.mock.callCount(), 0, "the graph must not paste its previously copied node");

    for (const target of [widget.editor, widget.search, widget.blockName, widget.blockRaw, widget.conditionValue]) {
        for (const modifiers of [{ ctrlKey: true }, { metaKey: true }, { ctrlKey: true, shiftKey: true }]) {
            const key = bubble(target, "keydown", { key: "v", ...modifiers });
            assert.equal(Boolean(key.defaultPrevented), false, "the browser must still emit the text paste");
        }
        if (target !== widget.editor) assert.equal(Boolean(bubble(target, "paste", { clipboardData }).defaultPrevented), false);
    }
    widget.openBlock("hair"); widget.renderBlockVariants();
    clipboardData.setData("text/plain", "{~pasted|variants}");
    bubble(widget.variants.querySelector(".vnccs-pd-variant-text"), "paste", { clipboardData });
    assert.equal(widget.activeBlock().text, "{~pasted|variants}");
    assert.equal(graphPaste.mock.callCount(), 0); assert.equal(graphKey.mock.callCount(), 0);
    bubble(document.body, "paste", { clipboardData }); bubble(document.body, "keydown", { key: "v", ctrlKey: true });
    assert.equal(graphPaste.mock.callCount(), 1, "canvas paste remains available outside the widget");
    assert.equal(graphKey.mock.callCount(), 1);
});

test("paste in the Prompt Designer rename dialog cannot duplicate a canvas node", t => {
    const { widget } = setup(t);
    document.append(document.body);
    const graphPaste = t.mock.fn(); document.addEventListener("paste", graphPaste);
    widget.libraryActions.dialog({ title: "Rename block", message: "Choose a name.", value: "Hair", action() {} });
    const input = widget.libraryActions.popup.element.querySelector("input");
    const pasted = bubble(input, "paste", { clipboardData: transfer() });
    assert.equal(Boolean(pasted.defaultPrevented), false, "native input paste must remain available");
    assert.equal(graphPaste.mock.callCount(), 0);
    widget.events.abort();
    assert.equal(widget.libraryActions.popup, null);
});

test("the first Enter after paste adds one visible trailing line without saving the caret placeholder", t => {
    const { widget } = setup(t);
    const clipboardData = transfer(); clipboardData.setData("text/plain", "pasted text");
    widget.editor.replaceChildren(); widget.savePromptEditor(widget.editor);
    emit(widget.editor, "paste", { clipboardData });
    for (const inputType of ["insertParagraph", "insertLineBreak"]) {
        const event = emit(widget.editor, "beforeinput", { inputType });
        assert.equal(event.defaultPrevented, true);
        assert.equal(widget.editor.lastChild.tagName, "BR", "the final empty line needs a rendered caret anchor");
        assert.equal(widget.editor.lastChild.dataset.pdCaretEnd, "true");
        const count = inputType === "insertParagraph" ? 1 : 2;
        assert.deepEqual(readEditor(widget.editor), [{ text: "pasted text" + "\n".repeat(count) }]);
        assert.deepEqual(JSON.parse(widget.node.widgets[0].value).parts, readEditor(widget.editor));
    }
    widget.render();
    assert.equal(widget.editor.lastChild.dataset.pdCaretEnd, "true", "restored trailing lines also remain visible");
    const next = text("next line"); widget.editor.append(next); emit(widget.editor, "input");
    assert.equal(widget.editor.children.some(child => child.dataset.pdCaretEnd), false);
    assert.deepEqual(readEditor(widget.editor), [{ text: "pasted text\n\nnext line" }]);
});

test("variant Enter keeps its trailing line visible and persists exactly one newline", t => {
    const { widget, selection } = setup(t);
    widget.openBlock("hair"); widget.saveBlockSource("{~one|two}"); widget.renderBlockVariants();
    const editor = widget.variants.querySelector(".vnccs-pd-variant-text");
    t.mock.method(editor, "dispatchEvent", event => { emit(editor, event.type); return true; });
    const range = document.createRange(); range.selectNodeContents(editor); range.collapse(false); selection.addRange(range);
    emit(editor, "beforeinput", { inputType: "insertParagraph" });
    assert.equal(editor.lastChild.tagName, "BR");
    assert.equal(editor.lastChild.dataset.pdCaretEnd, "true");
    assert.equal(widget.activeBlock().text, "{~one\n|two}");
    assert.deepEqual(readEditor(editor), [{ text: "one\n" }]);
});

test("compact inline condition outputs retain their single-row layout and exact text", t => {
    const { widget } = setup(t);
    const chip = widget.conditionChip({ blockId: "hair", operator: "equals", value: "hair", then: { text: "output\n" } });
    const output = chip.conditionControls.output;
    assert.equal(output.children.some(child => child.dataset.pdCaretEnd), false);
    assert.deepEqual(readEditor(output), [{ text: "output\n" }]);
});

test("restored empty prompts stay empty and new cards contain no placeholder values", t => {
    const empty = normalizeState({ version: 1, blocks: [], parts: [] });
    assert.deepEqual(empty.blocks, []);
    assert.deepEqual(empty.parts, []);
    const { widget } = setup(t);
    widget.newBlock(); widget.renderBlockVariants();
    assert.equal(widget.activeBlock().text, "");
    assert.equal(widget.variants.children.length, 1);
    assert.equal(widget.variants.children[0].children[1].textContent, "");
});

test("library click opens immediately and prompt deletion gestures do not apply to library cards", t => {
    const { widget } = setup(t);
    const order = widget.list.children.map(row => row.dataset.blockId);
    const row = widget.list.children.find(row => row.dataset.blockId === "clothing");
    emit(row, "click");
    assert.equal(widget.state.activeTab, "clothing");
    assert.equal(widget.selectedCard, null);
    assert.deepEqual(widget.list.children.map(row => row.dataset.blockId), order);
    for (const key of ["Delete", "Backspace"]) emit(widget.container, "keydown", { key, target: row });
    assert.equal(widget.state.blocks.some(block => block.id === "clothing"), true);
    assert.equal(widget.state.openTabs.includes("clothing"), true);
    assert.equal(widget.editor.querySelectorAll("[data-block-id]").some(chip => chip.dataset.blockId === "clothing"), true);
});

test("stale library callbacks use the current card after immutable edits and cannot duplicate or reset it", t => {
    const { widget } = setup(t);
    const row = widget.list.children.find(row => row.dataset.blockId === "artists");
    const before = widget.state.blocks.length;
    widget.openBlock("artists");
    widget.saveBlockSource("{~Girl|Boy}");
    emit(row, "click");
    const dataTransfer = transfer(); emit(row, "dragstart", { dataTransfer });
    assert.equal(widget.state.blocks.length, before);
    assert.equal(dataTransfer.getData("application/x-vnccs-prompt-block"), "artists");
    assert.equal(dataTransfer.getData("text/plain"), "{~Girl|Boy}");
    assert.equal(JSON.parse(widget.node.widgets[0].value).blocks[0].text, "{~Girl|Boy}");
    assert.deepEqual(widget.list.children.map(row => row.dataset.blockId), ["artists", "clothing", "hair", "pose"],
        "editing and clicking must not reorder cards");
});

test("prompt card click selects, Enter opens, Backspace removes only that occurrence", t => {
    const { widget } = setup(t);
    const chip = widget.editor.querySelector("[data-block-id]");
    emit(widget.editor, "click", { target: chip });
    assert.equal(widget.selectedCard, chip); assert.equal(widget.state.activeTab, "prompt");
    emit(widget.container, "keydown", { key: "Enter", target: chip });
    assert.equal(widget.state.activeTab, "artists");
    widget.switchTab("prompt");
    emit(widget.editor, "click", { target: chip });
    emit(widget.container, "keydown", { key: "Backspace", target: chip });
    assert.equal(widget.state.parts.some(part => part.blockId === "artists"), false);
    assert.equal(widget.state.blocks.some(block => block.id === "artists"), true);
});

test("Space after a selected prompt card or If separates adjacent cards without replacing them", t => {
    const { widget, selection } = setup(t);
    for (const kinds of [["block", "block"], ["block", "if"], ["if", "block"], ["if", "if"]]) {
        const cards = kinds.map(kind => kind === "block" ? widget.chip("hair") : widget.conditionChip({
            blockId: "artists", operator: "equals", value: "Girl", then: { text: "matched" }, else: { text: "other" },
        }));
        widget.editor.replaceChildren(...cards); widget.savePromptEditor(widget.editor);
        const before = structuredClone(widget.state.parts);
        widget.selectCard(cards[0], widget.editor);
        const stale = document.createRange(); stale.selectNode(cards[1]); selection.addRange(stale);
        const event = emit(widget.editor, "keydown", { target: cards[0], key: " " });
        assert.equal(event.defaultPrevented, true);
        assert.equal(event.stopped, true);
        assert.deepEqual(widget.editor.childNodes, [cards[0], widget.editor.childNodes[1], cards[1]]);
        assert.equal(widget.editor.childNodes[1].textContent, " ");
        assert.deepEqual(widget.state.parts, [before[0], { text: " " }, before[1]]);
        assert.deepEqual(JSON.parse(widget.node.widgets[0].value).parts, widget.state.parts);
        assert.equal(widget.selectedCard, null);
        assert.equal(document.activeElement, widget.editor);
        assert.equal(selection.range.startContainer, widget.editor);
        assert.equal(selection.range.startOffset, 2);
        assert.equal(Boolean(emit(widget.editor, "keydown", { key: " " }).defaultPrevented), false);
    }
    const condition = widget.editor.firstChild;
    widget.selectCard(condition, widget.editor);
    const field = condition.conditionControls.value;
    assert.equal(Boolean(emit(widget.editor, "keydown", { target: field, key: " " }).defaultPrevented), false);
    assert.equal(Boolean(emit(widget.editor, "keydown", { target: condition, key: " ", ctrlKey: true }).defaultPrevented), false);
});

test("If checks and outputs edit inline, extras sync with inspector and source deletion preserves logic", t => {
    const { widget } = setup(t), chip = insertIf(widget);
    const fields = chip.conditionControls;
    assert.equal(fields.source.children.length, 0);
    assert.equal(fields.operator.value, "");
    assert.deepEqual(fields.operator.children.filter(option => !option.disabled && !option.hidden).map(option => option.value),
        ["contains", "equals", "not_equals", "not_contains"]);
    const dataTransfer = transfer(); dataTransfer.setData("application/x-vnccs-prompt-block", "artists");
    emit(fields.source, "drop", { dataTransfer });
    fields.operator.value = "equals"; emit(fields.operator, "change");
    fields.value.value = "Girl"; emit(fields.value, "input");
    fields.output.textContent = "matched"; emit(fields.output, "input");
    fields.elseOutput.textContent = "other"; emit(fields.elseOutput, "input");
    widget.editCondition(chip); widget.addConditionClause("and"); widget.addConditionClause("or");
    const extra = fields.clauses.children[0].conditionControls;
    emit(extra.source, "drop", { dataTransfer });
    extra.operator.value = "contains"; emit(extra.operator, "change");
    extra.value.value = "Girl"; emit(extra.value, "input");
    assert.equal(widget.conditionExtraRows.children[0].conditionControls.source.value, "artists");
    assert.equal(widget.conditionExtraRows.children[0].conditionControls.value.value, "Girl");
    const sourceChip = fields.source.querySelector("[data-block-id]");
    emit(fields.source, "click", { target: sourceChip });
    emit(fields.source, "keydown", { target: sourceChip, key: "Delete" });
    const condition = JSON.parse(widget.node.widgets[0].value).parts[0].condition;
    assert.equal(condition.blockId, ""); assert.equal(condition.operator, "equals");
    assert.deepEqual(condition.then, { text: "matched" }); assert.deepEqual(condition.else, { text: "other" });
    assert.equal(condition.clauses.length, 2); assert.equal(condition.clauses[0].blockId, "artists");
    assert.equal(widget.editor.contains(chip), true); assert.equal(widget.state.blocks.length, 4);
});

test("only the If handle starts moving the whole condition", t => {
    const { widget } = setup(t), chip = insertIf(widget);
    assert.equal(chip.draggable, false);
    const margin = emit(widget.editor, "dragstart", { target: chip, dataTransfer: transfer() });
    assert.equal(margin.defaultPrevented, true); assert.equal(widget.promptDrag, undefined);
    const handle = chip.querySelector(".vnccs-pd-condition-handle");
    emit(widget.editor, "dragstart", { target: handle, dataTransfer: transfer() });
    assert.equal(widget.promptDrag.card, chip);
});

test("compact If fields size to their content and retain full text, mixed outputs and additional checks", async t => {
    const { widget } = setup(t), chip = insertIf(widget);
    const condition = { blockId: "artists", operator: "equals", value: "Girl", then: { blockId: "pose" },
        else: { text: "A long fallback sentence\nwith another line" },
        clauses: [{ join: "and", blockId: "hair", operator: "contains", value: "white" }] };
    widget.labelCondition(chip, condition); widget.saveInlineCondition(chip);
    const fields = chip.conditionControls;
    assert.equal(fields.value.style.width, "calc(4ch + 12px)");
    assert.equal(fields.operator.style.width, "calc(6ch + 24px)");
    assert.equal(fields.clauses.children[0].conditionControls.value.style.width, "calc(5ch + 12px)");
    assert.equal(fields.elseOutput.title, condition.else.text);
    assert.deepEqual(widget.state.parts[0].condition, condition);
    fields.value.value = "A comparison longer than its compact input"; emit(fields.value, "input");
    assert.equal(fields.value.style.width, "calc(12ch + 12px)");
    assert.equal(widget.state.parts[0].condition.value, fields.value.value);
    assert.equal(fields.value.title, fields.value.value);
    widget.editCondition(chip);
    assert.equal(widget.conditionValue.value, fields.value.value);
    assert.deepEqual(readEditor(widget.conditionElseOutput), [condition.else]);
    const css = await readFile(new URL("../web/prompt_designer/styles.mjs", import.meta.url), "utf8");
    const root = css.split("\n").find(line => line.startsWith(".vnccs-pd-condition {"));
    assert.match(root, /flex-wrap:nowrap/); assert.match(root, /max-width:min\(100%,72ch\)/);
    const output = css.split("\n").find(line => line.startsWith(".vnccs-pd-condition .vnccs-pd-condition-output {"));
    assert.match(output, /flex:none/); assert.match(output, /max-height:26px/); assert.match(output, /white-space:nowrap/);
});

test("dragging a prompt card into Then copies its reference without moving the main occurrence", t => {
    const { widget } = setup(t), condition = insertIf(widget);
    const original = widget.chip("hair"); widget.editor.append(original); widget.savePromptEditor(widget.editor);
    const dataTransfer = transfer(); emit(widget.editor, "dragstart", { target: original, dataTransfer });
    const output = condition.conditionControls.output;
    const range = document.createRange(); range.selectNodeContents(output); range.collapse(false);
    t.mock.method(widget, "rangeAt", (x, y, editor) => { assert.equal(editor, output); return range; });
    const over = emit(output, "dragover", { dataTransfer });
    assert.equal(over.defaultPrevented, true); assert.equal(dataTransfer.dropEffect, "copy");
    emit(output, "drop", { dataTransfer });
    assert.equal(widget.editor.contains(original), true);
    assert.notEqual(output.querySelector("[data-block-id]"), original);
    assert.deepEqual(widget.state.parts[0].condition.then, { blockId: "hair" });
    assert.deepEqual(widget.state.parts[1], { blockId: "hair" });
});

test("card drops before a leading If need no whitespace and nested output drops stay inside their editor", t => {
    const { widget } = setup(t);
    for (const caret of ["inside", "after", "missing"]) {
        const condition = insertIf(widget);
        condition.getBoundingClientRect = () => ({ left: 100, right: 700, top: 50, bottom: 80 });
        document.elementFromPoint = () => caret === "inside" ? condition.firstChild : widget.editor;
        document.caretRangeFromPoint = () => {
            if (caret === "missing") return null;
            const range = document.createRange();
            if (caret === "inside") range.setStart(condition.firstChild, 0);
            else range.setStartAfter(condition);
            range.collapse(true); return range;
        };
        const dataTransfer = transfer(); dataTransfer.setData("application/x-vnccs-prompt-block", "hair");
        const clientX = caret === "inside" ? 105 : 90;
        emit(widget.editor, "dragover", { dataTransfer, clientX, clientY: 60 });
        assert.equal(widget.caret?.startContainer, widget.editor, caret);
        assert.equal(widget.caret?.startOffset, 0, caret);
        emit(widget.editor, "drop", { dataTransfer, clientX, clientY: 60 });
        assert.deepEqual(widget.state.parts.map(part => part.blockId ?? "if"), ["hair", "if"], caret);
        assert.equal(widget.editor.children[1], condition);
    }
    const condition = widget.editor.children[1], output = condition.conditionControls.output;
    const nested = widget.chip("pose"); output.replaceChildren(nested);
    nested.getBoundingClientRect = () => ({ left: 400, right: 480, top: 50, bottom: 80 });
    document.elementFromPoint = () => nested;
    document.caretRangeFromPoint = () => { const range = document.createRange(); range.setStart(nested.firstChild, 0); range.collapse(true); return range; };
    assert.equal(widget.rangeAt(405, 60, output).startContainer, output);
    assert.equal(widget.rangeAt(405, 60, output).startOffset, 0);
    assert.equal(widget.rangeAt(475, 60, output).startOffset, 1);
    assert.equal(widget.rangeAt(405, 60).startContainer, widget.editor);
    assert.equal(widget.rangeAt(405, 60).startOffset, 2);
});

test("deleting selected text ignores stale card selection and clips the neighboring If boundary", t => {
    const { widget, selection } = setup(t), chip = insertIf(widget);
    const sentence = text("remove this"); widget.editor.replaceChildren(sentence, chip); widget.savePromptEditor(widget.editor);
    widget.selectCard(chip, widget.editor);
    let clipped = false;
    const range = document.createRange();
    range.startContainer = sentence; range.endContainer = chip.firstChild; range.startOffset = 0; range.endOffset = 1;
    range.setEndBefore = node => { assert.equal(node, chip); clipped = true; };
    range.deleteContents = () => { assert.equal(clipped, true); sentence.textContent = ""; };
    selection.addRange(range); selection.isCollapsed = false;
    const event = emit(widget.editor, "keydown", { key: "Delete", target: widget.editor });
    assert.equal(event.defaultPrevented, true); assert.equal(event.stopped, true);
    assert.equal(widget.selectedCard, null); assert.equal(widget.editor.contains(chip), true);
    assert.equal(widget.state.parts.length, 1); assert.ok(widget.state.parts[0].condition);
});

test("selected prompt text starts a range move and cannot be dropped into its own range", t => {
    const { widget, selection } = setup(t);
    const sentence = text("one two three"); widget.editor.replaceChildren(sentence);
    const range = document.createRange(); range.setStart(sentence, 4); range.setEnd(sentence, 7); range.toString = () => "two";
    selection.addRange(range); selection.isCollapsed = false;
    const dataTransfer = transfer(); emit(widget.editor, "dragstart", { target: widget.editor, dataTransfer });
    assert.ok(widget.promptDrag.range); assert.equal(dataTransfer.getData("text/plain"), "two");
    widget.promptDrag.range.comparePoint = () => 0;
    t.mock.method(widget, "rangeAt", () => range);
    emit(widget.editor, "drop", { dataTransfer });
    assert.equal(sentence.textContent, "one two three");
});

test("editing rows appends a fresh blank row, persists on each keystroke and preserves weighted syntax", t => {
    const { widget } = setup(t);
    widget.openBlock("artists");
    widget.activeBlock().text = "{~2::ink|1::{~red|blue} coat}";
    widget.blockView.value = "variants"; widget.renderBlockVariants();
    const first = widget.variants.children[0].children[1];
    first.textContent = "watercolor"; emit(first, "input");
    assert.equal(widget.activeBlock().text, "{~2::watercolor|1::{~red|blue} coat}");
    const blank = widget.variants.children.at(-1).children[1];
    blank.textContent = "pencil"; emit(blank, "input");
    assert.equal(widget.activeBlock().text, "{~2::watercolor|1::{~red|blue} coat|pencil}");
    assert.equal(widget.variants.children.length, 4);
    assert.equal(widget.variants.children.at(-1).children[1].textContent, "");
    blank.textContent = "pencil drawing"; emit(blank, "input");
    assert.equal(JSON.parse(widget.node.widgets[0].value).blocks[0].text, "{~2::watercolor|1::{~red|blue} coat|pencil drawing}");
    assert.equal(widget.variants.children.length, 4);
});

test("clearing a variant removes its whole choice, renumbers rows and keeps one blank draft", t => {
    const { widget } = setup(t); widget.openBlock("artists");
    for (const [source, index, expected, values] of [
        ["{~Girl|Boy}", 0, "{~Boy}", ["Boy"]],
        ["{@2::Girl|3::{~red|blue} coat|4::Boy}", 1, "{@2::Girl|4::Boy}", ["Girl", "Boy"]],
        ["{~2$$ and $$2::Girl|3::Boy}", 0, "{~2$$ and $$3::Boy}", ["Boy"]],
        ["{~2::Girl|3::Boy}", 1, "{~2::Girl}", ["Girl"]],
        ["{~Girl}", 0, "", []],
        ["plain variant", 0, "", []],
    ]) {
        widget.saveBlockSource(source); widget.renderBlockVariants();
        const content = widget.variants.children[index].children[1];
        content.textContent = "\n"; emit(content, "input");
        assert.equal(widget.activeBlock().text, expected);
        assert.equal(JSON.parse(widget.node.widgets[0].value).blocks[0].text, expected);
        assert.deepEqual(widget.blockVariants.variants, values);
        assert.deepEqual(widget.variants.children.map(row => row.children[1].textContent), [...values, ""]);
        assert.deepEqual(widget.variants.children.map(row => row.children[0].textContent), values.concat("").map((_, index) => String(index + 1)));
        assert.equal(document.activeElement, widget.variants.children[Math.min(index, values.length)].children[1]);
        emit(content, "input"); assert.equal(widget.activeBlock().text, expected, "detached row callbacks cannot delete another choice");
    }
    const draft = widget.variants.children[0].children[1];
    draft.textContent = "New variant"; emit(draft, "input");
    assert.equal(widget.activeBlock().text, "{~New variant}");
    assert.equal(widget.variants.children.length, 2);
    draft.textContent = ""; emit(draft, "input");
    assert.equal(widget.activeBlock().text, ""); assert.equal(widget.variants.children.length, 1);
    widget.saveBlockSource("{~Girl|Boy|Girl in red}"); widget.blockSearch.value = "Girl"; widget.renderBlockVariants();
    const filtered = widget.variants.children[0].children[1]; filtered.textContent = ""; emit(filtered, "input");
    assert.equal(widget.activeBlock().text, "{~Boy|Girl in red}");
    assert.equal(widget.variants.children.length, 1);
    assert.equal(widget.variants.children[0].children[0].textContent, "2");
});

test("Text/Variants buttons show exactly one editor and sampling rewrites the same source", t => {
    const { widget } = setup(t);
    widget.openBlock("artists"); widget.showTab(); widget.renderBlockVariants();
    emit(widget.blockView.children.find(button => button.dataset.view === "text"), "click");
    assert.equal(widget.blockRaw.hidden, false); assert.equal(widget.variants.hidden, true);
    widget.blockRaw.value = "{~Girl|Boy}"; emit(widget.blockRaw, "input");
    emit(widget.blockView.children.find(button => button.dataset.view === "variants"), "click");
    assert.equal(widget.blockRaw.hidden, true); assert.equal(widget.variants.hidden, false);
    assert.deepEqual(widget.blockVariants.variants, ["Girl", "Boy"]);
    widget.setBlockPreference("mode", "cycle"); assert.equal(widget.activeBlock().text, "{@Girl|Boy}");
    widget.setBlockPreference("mode", "random"); assert.equal(widget.activeBlock().text, "{~Girl|Boy}");
});

test("panel widths and scroll survive widget reconstruction and inspector stays a layout column", async t => {
    const { widget } = setup(t);
    widget.inspector.hidden = false;
    widget.setPanelWidth("library", 720); widget.setPanelWidth("inspector", 510);
    widget.list.scrollTop = 125; widget.list.scrollLeft = 7; widget.savePanelScroll(widget.list);
    const saved = JSON.parse(JSON.stringify(widget.node.properties));
    const replacement = node(); replacement.properties = saved;
    const restored = new PromptDesignerWidget(replacement, {}); restored.render();
    assert.equal(restored.container.style["--pd-library-width"], "720px");
    assert.equal(restored.container.style["--pd-inspector-width"], "510px");
    assert.equal(restored.list.scrollTop, 125); assert.equal(restored.list.scrollLeft, 7);
    assert.equal(restored.inspector.parentNode, restored.workspace);
    const css = await readFile(new URL("../web/prompt_designer/styles.mjs", import.meta.url), "utf8");
    assert.match(css, /\.vnccs-pd-workspace\.has-inspector[^\n]*grid-template-columns:[^\n]*minmax\(0,1fr\) var\(--pd-inspector-size\)/);
    assert.match(css, /:is\(input,select,textarea,\[contenteditable="true"\]\):is\(:focus,:focus-visible\).*outline:none !important/);
});

test("category color affects cards and prompt chips and custom category survives serialization", t => {
    const { widget } = setup(t);
    widget.categoryName.value = "People"; widget.addCategory();
    widget.openBlock("hair"); widget.setBlockPreference("category", "People");
    widget.categoryColor.value = "#bb2233"; widget.setCategoryColor();
    assert.equal(widget.cardColor(widget.activeBlock()), "#bb2233");
    assert.equal(widget.chip("hair").style["--pd-chip-color"], "#bb2233");
    assert.deepEqual(normalizeState(JSON.parse(widget.node.widgets[0].value)).categories,
        [...defaultState().categories, { name: "People", color: "#bb2233" }]);
    widget.setStatus("Saved on disk · Browser backup ready"); assert.equal(widget.status.hidden, true); assert.equal(widget.status.textContent, "");
    widget.setStatus("Disk full", true); assert.equal(widget.status.hidden, false); assert.equal(widget.status.textContent, "Disk full");
});

test("source parsing preserves top-level row boundaries and excludes variable braces from sampling changes", () => {
    const source = " {~2$$ and $$2::ink|{~red|blue} coat| pencil } ";
    const parsed = blockRows(source);
    assert.equal(parsed.wrapped, true);
    assert.deepEqual(parsed.rows.map(row => source.slice(row.start, row.end)), ["ink", "{~red|blue} coat", "pencil"]);
    assert.equal(blockSourceMode("${color} {~red|blue}", "cycle"), "${color} {@red|blue}");
    assert.equal(blockRows("before {~red|blue} after").wrapped, false);
});

test("widget forwards middle-button pan and canvas zoom while preserving scrollable editor wheel input", async t => {
    const { widget } = setup(t), canvas = dom("canvas"), eventWindow = dom();
    const forwarded = [];
    canvas.dispatchEvent = event => forwarded.push(event);
    const source = await readFile(new URL("../web/vnccs_prompt_designer.js", import.meta.url), "utf8");
    class InputEvent {
        constructor(type, init) { this.type = type; Object.assign(this, init); }
    }
    const context = { app: { canvasEl: canvas, registerExtension() {} }, window: eventWindow,
        PointerEvent: InputEvent, MouseEvent: InputEvent, WheelEvent: InputEvent,
        getComputedStyle: element => ({ overflowY: element.overflowY ?? "visible", overflowX: "visible" }) };
    runInNewContext(source.replace(/^import .*;$/gm, "") + "\nglobalThis.installNavigation = enablePromptCanvasNavigation;", context);
    context.installNavigation(widget);
    const down = emit(widget.container, "pointerdown", { button: 1, pointerId: 7, clientX: 100, clientY: 200 });
    assert.equal(down.defaultPrevented, true);
    emit(eventWindow, "pointermove", { pointerId: 7, clientX: 120, clientY: 205 });
    emit(eventWindow, "pointerup", { pointerId: 7, clientX: 120, clientY: 205 });
    assert.deepEqual(forwarded.map(event => event.type), ["pointerdown", "mousedown", "pointermove", "mousemove", "pointerup", "mouseup"]);
    assert.ok(forwarded.every(event => event._vnccsPromptForwardedCanvasInput));
    assert.equal(forwarded[2].clientX, 120);
    forwarded.length = 0;
    widget.editor.overflowY = "auto"; widget.editor.scrollHeight = 1000; widget.editor.clientHeight = 200;
    emit(widget.container, "wheel", { target: widget.editor, deltaY: 100 });
    assert.equal(forwarded.length, 0, "scrolling an editor must not zoom the canvas");
    const zoom = emit(widget.container, "wheel", { target: widget.editor, deltaY: -40, ctrlKey: true });
    assert.equal(zoom.defaultPrevented, true); assert.equal(forwarded[0].type, "wheel"); assert.equal(forwarded[0].deltaY, -40);
    forwarded.length = 0;
    emit(widget.container, "pointerdown", { button: 1, pointerId: 7 }); widget.events.abort();
    assert.equal(forwarded.at(-1).type, "mouseup", "disposing during pan must release canvas dragging");
});
