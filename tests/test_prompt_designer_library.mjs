import assert from "node:assert/strict";
import test from "node:test";
import { PromptDesignerWidget } from "../web/prompt_designer/widget.mjs";
import { promptSnapshot, openPromptState } from "../web/prompt_designer/prompt_library.mjs";
import { normalizeState, removeBlock } from "../web/prompt_designer/state.mjs";
import { sampleState, installDom, node } from "./helpers/prompt_designer_dom.mjs";
const restoreFromNode = PromptDesignerWidget.prototype.loadFromNode;

function composed() {
    return normalizeState({ ...sampleState(), parts: [
        { text: "quiet scene,\n" }, { blockId: "artists" },
        { condition: { blockId: "hair", operator: "contains", value: "white", then: { parts: [{ text: "wear " }, { blockId: "clothing" }] },
            else: { blockId: "pose" }, clauses: [{ join: "and", blockId: "artists", operator: "not_equals", value: "ink" }] } },
        { multiPrompt: { variants: [[{ blockId: "pose" }], [{ text: "second " }, { blockId: "clothing" }]] } },
    ], blocks: [...sampleState().blocks, { id: "unused", name: "Unused", text: "keep me" }] });
}

test("saved prompt includes all references, mixed branches and multi outputs, excludes unused blocks and remaps collisions safely", () => {
    const original = { ...composed(), cycleIndex: 2 }, snapshot = promptSnapshot(original);
    assert.deepEqual(snapshot.blocks.map(block => block.id), ["artists", "clothing", "hair", "pose"]);
    assert.deepEqual(snapshot.parts, original.parts);
    assert.equal(original.blocks.length, 5);
    const current = normalizeState({ ...original, cycleIndex: 7, blocks: original.blocks.map(block => block.id === "hair" ? { ...block, text: "my edited hair" } : block) });
    const reopened = openPromptState(current, snapshot);
    assert.equal(reopened.cycleIndex, 2);
    assert.equal(openPromptState(reopened, { ...snapshot, cycleIndex: undefined }).cycleIndex, undefined);
    const savedHair = reopened.blocks.find(block => block.text === snapshot.blocks[2].text);
    assert.notEqual(savedHair.id, "hair");
    assert.equal(reopened.blocks.find(block => block.id === "hair").text, "my edited hair");
    assert.equal(reopened.parts[2].condition.blockId, savedHair.id);
    assert.equal(reopened.blocks.find(block => block.id === "unused").text, "keep me");
    assert.equal(openPromptState(reopened, snapshot).blocks.length, reopened.blocks.length, "reopening cannot multiply identical cards");
    assert.deepEqual(promptSnapshot(reopened).parts, reopened.parts);
});

function setup(t) {
    installDom(t);
    t.mock.method(PromptDesignerWidget.prototype, "loadFromNode", function () { this.state = composed(); });
    const records = new Map();
    const api = { async fetchApi(url, options = {}) {
        if (url.includes("/prompts?")) {
            const prompts = [...records].filter(([, record]) => record.state.savedPrompt).map(([id, record]) => ({ id, revision: record.revision,
                ...record.state.savedPrompt, text: "quiet scene" }));
            return Response.json({ prompts, total: prompts.length });
        }
        if (url.includes("/library?") || url.includes("/defaults?")) return Response.json({ cards: [], total: 0 });
        const id = url.split("/").at(-1);
        if (options.method === "PUT") {
            const data = JSON.parse(options.body), current = records.get(id);
            if ((current?.revision ?? 0) !== data.revision) return Response.json({ error: "Newer edits exist." }, { status: 409 });
            records.set(id, { state: data.state, revision: data.revision + 1 }); return Response.json({ revision: data.revision + 1 });
        }
        return Response.json(records.get(id) ?? { state: null, revision: 0 });
    } };
    const widget = new PromptDesignerWidget(node(), api);
    t.mock.method(widget, "schedulePreview", () => {}); t.mock.method(widget, "scheduleBlockPreview", () => {});
    widget.render(); widget.commit(null, false);
    t.after(() => { widget.events.abort(); clearTimeout(widget.libraryTimer); });
    return { widget, records };
}

test("same-content cards keep separate categories and colors through filtering, import and deletion", t => {
    const { widget } = setup(t);
    const cards = [
        { id: "first", name: "Same card", text: "same text", category: "First", color: "#112233" },
        { id: "second", name: "Same card", text: "same text", category: "Second", color: "#445566" },
        { id: "third", name: "Same card", text: "same text", category: "Second", color: "#778899" },
    ];
    widget.savedCards = [...cards, { ...cards[0], id: "duplicate" }]; widget.renderLibrary();
    const rows = () => widget.list.children.filter(row => row.querySelector(".vnccs-pd-block-name")?.textContent === "Same card");
    assert.equal(rows().length, 3);
    widget.libraryCategory = "Second"; widget.renderLibrary();
    assert.deepEqual(rows().filter(row => !row.hidden).map(row => row.style["--pd-chip-color"]), ["#445566", "#778899"]);
    const imported = cards.map(card => widget.useLibraryBlock(card));
    cards.forEach((card, index) => {
        assert.deepEqual({ ...imported[index], id: card.id }, card);
        assert.equal(widget.useLibraryBlock(card).id, imported[index].id);
    });
    assert.equal(new Set(imported.map(card => card.id)).size, 3);
    assert.ok(widget.deleteBlock(imported[0]));
    assert.equal(widget.state.blocks.some(card => card.id === imported[0].id), false);
    assert.ok(imported.slice(1).every(card => widget.state.blocks.some(item => item.id === card.id)));
    assert.equal(rows().length, 2);
    assert.ok(rows().every(row => !row.hidden));
});

test("importing a card merges category casing, retains the current color and reuses its copy", t => {
    const { widget } = setup(t), parts = structuredClone(widget.state.parts);
    widget.state.categories = [{ name: "Clothes", color: "#112233" }];
    widget.savedCategories = [{ name: "clothes", color: "#445566" }];
    const card = { id: "catalog", name: "Imported coat", text: "coat", category: "clothes" };
    widget.savedCards = [card];
    assert.deepEqual(widget.categoryDefinitions(), [{ name: "Clothes", color: "#112233" }]);
    const imported = widget.useLibraryBlock(card);
    assert.equal(imported.category, "Clothes");
    assert.equal(imported.color, undefined, "inherited color must remain a category preference");
    assert.equal(widget.cardColor(imported), "#112233");
    assert.equal(widget.useLibraryBlock(card).id, imported.id);
    assert.deepEqual(widget.state.categories, [{ name: "Clothes", color: "#112233" }]);
    assert.deepEqual(widget.state.parts, parts);
    widget.libraryCategory = "Clothes"; widget.renderLibrary();
    assert.equal(widget.list.children.find(row => row.dataset.blockId === imported.id).hidden, false);
    assert.equal(widget.list.children.some(row => row.dataset.blockId === card.id), false);
});

test("legacy hidden-card keys remain hidden after the card identity gains category and color", t => {
    const { widget } = setup(t);
    const card = { id: "catalog", name: "Previously deleted", text: "coat", category: "Clothes", color: "#112233" };
    widget.defaultCards = [card];
    widget.deletedLibraryKeys = new Set([JSON.stringify([card.name, card.text, "random"])]);
    widget.renderLibrary();
    assert.equal(widget.list.children.some(row => row.dataset.blockId === card.id), false);
});

test("opening a template merges category casing and reuses canonically matching blocks without changing either source", () => {
    const current = normalizeState({ categories: [{ name: "Clothes", color: "#112233" }],
        blocks: [{ id: "current", name: "Coat", text: "coat", category: "Clothes" }], parts: [{ text: "current draft" }] });
    const saved = normalizeState({ categories: [{ name: "clothes", color: "#445566" }, { name: "Landscape" }],
        blocks: [{ id: "saved", name: "Coat", text: "coat", category: "clothes" },
            { id: "new", name: "Shirt", text: "shirt", category: "CLOTHES" }],
        parts: [{ blockId: "saved" }, { blockId: "new" }] });
    const before = structuredClone({ current, saved });
    const reopened = openPromptState(current, saved);
    assert.deepEqual(reopened.categories, [{ name: "Clothes", color: "#112233" }, { name: "Landscape" }]);
    assert.deepEqual(reopened.parts, [{ blockId: "current" }, { blockId: "new" }]);
    assert.equal(reopened.blocks.length, 2);
    assert.ok(reopened.blocks.every(block => block.category === "Clothes"));
    assert.deepEqual({ current, saved }, before);
    assert.equal(openPromptState(reopened, saved).blocks.length, 2);
});

test("opening and saving a template canonicalizes its category while retaining the other prompt draft", async t => {
    const { widget, records } = setup(t), original = widget.state.activePrompt, parts = structuredClone(widget.state.parts);
    widget.state.categories = [{ name: "Clothes", color: "#112233" }]; widget.commit();
    const id = "a".repeat(32);
    const saved = { ...normalizeState({ categories: [{ name: "clothes", color: "#445566" }],
        blocks: [{ id: "saved", name: "Coat", text: "coat", category: "clothes" }], parts: [{ blockId: "saved" }] }),
        savedPrompt: { name: "My coat", category: "clothes" } };
    records.set(id, { state: saved, revision: 1 });
    await widget.openSavedPrompt({ id, revision: 1 });
    assert.notEqual(widget.state.activePrompt, original);
    assert.equal(widget.activePrompt().dirty, false);
    assert.equal(widget.activePrompt().details.category, "Clothes");
    assert.equal(widget.promptCategory.value, "Clothes");
    assert.deepEqual(widget.state.promptTabs.find(tab => tab.id === original).parts, parts);
    assert.deepEqual(records.get(id).state, saved, "opening cannot rewrite the stored template");
    assert.equal(await widget.saveLibraryPrompt(), true);
    assert.equal(records.get(id).state.savedPrompt.category, "Clothes");
    assert.equal(records.get(id).state.blocks[0].category, "Clothes");
    assert.deepEqual(records.get(id).state.categories, [{ name: "Clothes", color: "#112233" }]);
});

test("library tabs save, list and reopen complete prompts with independent colors and categories", async t => {
    const { widget, records } = setup(t), before = structuredClone(widget.state.parts);
    const saveButton = widget.container.querySelector(".vnccs-pd-toolbar").lastElementChild;
    assert.equal(saveButton.textContent, "Save Prompt Template");
    assert.ok(saveButton.classList.contains("primary"));
    saveButton.listeners.get("click")();
    assert.equal(widget.inspectorPanel, widget.promptPanel);
    widget.promptName.value = "Quiet scene"; widget.promptCategory.value = "Backgrounds";
    widget.promptColor.value = "#44bb99"; widget.savePromptDetails();
    await widget.saveLibraryPrompt();
    const id = widget.editingSavedPrompt.id;
    assert.deepEqual(records.get(id).state.parts, before);
    assert.equal(records.get(id).state.blocks.length, 4);
    widget.setLibraryView("prompts"); await widget.loadSavedPrompts();
    assert.equal(widget.node.properties.promptDesignerLibraryTab, "prompts");
    assert.equal(widget.list.children.length, 1);
    assert.equal(widget.list.children[0].style["--pd-chip-color"], "#44bb99");
    assert.equal(widget.libraryAction.textContent, "+ Save Prompt Template");
    widget.newPrompt(); const draft = widget.state.activePrompt;
    widget.state.parts = [{ text: "working draft" }]; widget.render(); widget.commit();
    await widget.openSavedPrompt(widget.savedPrompts[0]);
    assert.deepEqual(widget.state.parts, before);
    assert.deepEqual(widget.state.promptTabs.find(tab => tab.id === draft).parts, [{ text: "working draft" }]);
    assert.equal(widget.inspectorPanel, widget.promptPanel);
    assert.equal(widget.promptCategory.value, "Backgrounds");
    widget.promptName.value = "Renamed scene"; widget.promptColor.value = "#eeaa77";
    const row = widget.list.children[0];
    widget.promptColor.dispatchEvent({ type: "input" });
    assert.equal(widget.list.children[0], row, "continuous color input keeps the same visible card");
    assert.equal(row.style["--pd-chip-color"], "#eeaa77");
    assert.equal(row.querySelector(".vnccs-pd-block-name").textContent, "Renamed scene");
    assert.equal(records.get(id).state.savedPrompt.color, "#44bb99", "metadata is committed to disk only on save");
    await widget.saveLibraryPrompt();
    assert.equal(records.size, 1); assert.equal(records.get(id).revision, 2);
    assert.equal(records.get(id).state.savedPrompt.name, "Renamed scene");
    assert.equal(widget.list.children[0].style["--pd-chip-color"], "#eeaa77");
    await widget.saveLibraryPrompt(true);
    assert.equal(records.size, 2); assert.notEqual(widget.editingSavedPrompt.id, id);
    widget.libraryCategory = "Clothes"; widget.renderLibrary(); assert.ok(widget.list.children.every(row => row.hidden));
});

test("failed and stale prompt requests retain current edits and never show an unacknowledged library entry", async t => {
    const { widget } = setup(t);
    widget.editPromptDetails(); widget.promptName.value = "My prompt";
    const before = structuredClone(widget.state);
    widget.api.fetchApi = async () => Response.json({ error: "disk full" }, { status: 500 });
    await widget.saveLibraryPrompt();
    const retry = widget.activePrompt().details;
    assert.equal(retry.revision, 0); assert.equal(widget.activePrompt().dirty, true);
    before.promptTabs[0].details = { ...retry };
    assert.deepEqual(widget.state, before); assert.equal(widget.savedPrompts, undefined);
    assert.match(widget.status.textContent, /disk full/);
    let complete;
    widget.api.fetchApi = () => new Promise(resolve => { complete = resolve; });
    const opening = widget.openSavedPrompt({ id: "a".repeat(32) });
    widget.state.parts = [{ text: "newer draft" }]; widget.commit();
    complete(Response.json({ state: { ...promptSnapshot(before), savedPrompt: { name: "Old", category: "" } }, revision: 1 }));
    await opening; assert.deepEqual(widget.state.parts, [{ text: "newer draft" }]);
});

test("deleting a template removes it from the library while keeping the open prompt and reusable cards", async t => {
    const { widget, records } = setup(t);
    widget.editPromptDetails(); assert.equal(widget.promptDelete.hidden, true);
    widget.promptName.value = "My template"; await widget.saveLibraryPrompt();
    const id = widget.editingSavedPrompt.id, snapshot = structuredClone(records.get(id).state);
    widget.libraryView = "prompts"; widget.renderLibrary();
    assert.equal(widget.promptDelete.hidden, false);
    const current = structuredClone(widget.state);
    let deletion;
    const remove = widget.deleteLibraryPrompt;
    t.mock.method(widget, "deleteLibraryPrompt", function () { deletion = remove.call(this); });
    widget.promptDelete.listeners.get("click")();
    assert.ok(records.get(id).state.savedPrompt, "opening the confirmation does not delete the template");
    widget.libraryActions.popup.element.querySelector("form").listeners.get("submit")(); await deletion;
    assert.equal(records.get(id).state.savedPrompt, undefined);
    assert.deepEqual(records.get(id).state.blocks, snapshot.blocks);
    assert.deepEqual(records.get(id).state.parts, snapshot.parts);
    delete current.promptTabs[0].details.id; delete current.promptTabs[0].details.revision; current.promptTabs[0].dirty = true;
    assert.deepEqual(widget.state, current);
    assert.equal(widget.editingSavedPrompt, null);
    assert.equal(widget.node.properties.promptDesignerPromptDetails.id, undefined);
    assert.equal(widget.promptDelete.hidden, true);
    await widget.loadSavedPrompts(); assert.deepEqual(widget.savedPrompts, []);
    assert.equal(widget.list.querySelector(".vnccs-pd-block"), null);
    await widget.saveLibraryPrompt(); assert.notEqual(widget.editingSavedPrompt.id, id);
});

test("failed or conflicting template deletion keeps the library entry and ignores a stale catalog after successful deletion", async t => {
    const { widget, records } = setup(t); widget.editPromptDetails();
    widget.promptName.value = "My template"; await widget.saveLibraryPrompt();
    const entry = widget.editingSavedPrompt, snapshot = structuredClone(records.get(entry.id));
    const fetch = widget.api.fetchApi;
    widget.api.fetchApi = async (url, options) => options?.method === "PUT"
        ? Response.json({ error: "disk full" }, { status: 500 }) : fetch(url, options);
    await widget.deleteLibraryPrompt();
    assert.match(widget.status.textContent, /disk full/);
    assert.equal(widget.savedPrompts[0].id, entry.id);
    assert.equal(widget.promptDelete.disabled, false);
    assert.deepEqual(records.get(entry.id), snapshot);
    widget.api.fetchApi = fetch; records.get(entry.id).revision++;
    await widget.deleteLibraryPrompt();
    assert.match(widget.status.textContent, /newer edits/);
    assert.equal(widget.savedPrompts.length, 1);
    records.get(entry.id).revision = entry.revision;
    let complete;
    widget.api.fetchApi = (url, options) => url.includes("/prompts?")
        ? new Promise(resolve => { complete = resolve; }) : fetch(url, options);
    const older = widget.loadSavedPrompts();
    await widget.deleteLibraryPrompt();
    complete(Response.json({ prompts: [entry], total: 1 })); await older;
    assert.deepEqual(widget.savedPrompts, []);
});

test("prompt library reads later pages and rejects obsolete query responses", async t => {
    const { widget } = setup(t), requests = [];
    const prompts = Array.from({ length: 51 }, (_, index) => ({ id: index.toString(16).padStart(32, "0"),
        name: `Scene ${index}`, category: "Backgrounds", color: "#44bb99", revision: 1, text: "quiet scene" }));
    widget.api.fetchApi = async url => {
        requests.push(url); const offset = Number(new URL(url, "http://localhost").searchParams.get("offset"));
        return Response.json({ prompts: prompts.slice(offset, offset + 50), total: prompts.length });
    };
    widget.libraryView = "prompts"; await widget.loadSavedPrompts();
    assert.equal(widget.list.children.length, 51);
    assert.match(requests[1], /offset=50/);
    let complete;
    widget.api.fetchApi = () => new Promise(resolve => { complete = resolve; });
    const older = widget.loadSavedPrompts();
    widget.api.fetchApi = async () => Response.json({ prompts: [prompts[50]], total: 1 });
    await widget.loadSavedPrompts();
    complete(Response.json({ prompts: [], total: 0 })); await older;
    assert.deepEqual(widget.savedPrompts, [prompts[50]]);
});

function context(widget, row, label) {
    const event = { clientX: 200, clientY: 100 };
    row.listeners.get("contextmenu")(event);
    assert.equal(event.defaultPrevented, true);
    assert.equal(event.stopped, true);
    const menu = widget.libraryActions.popup.element;
    assert.deepEqual(menu.children.map(button => button.textContent), ["Edit", "Rename", "Delete"]);
    if (label) menu.children.find(button => button.textContent === label).listeners.get("click")();
    return widget.libraryActions.popup?.element;
}

test("block context menu edits the targeted card, supports keyboard navigation and cleans up on outside click and disposal", t => {
    const { widget } = setup(t), hair = widget.list.children.find(row => row.dataset.blockId === "hair");
    let menu = context(widget, hair);
    assert.equal(menu.attributes.role, "menu");
    menu.listeners.get("keydown")({ key: "ArrowDown" });
    assert.equal(document.activeElement.textContent, "Rename");
    menu.listeners.get("keydown")({ key: "Escape" });
    assert.equal(widget.libraryActions.popup, null);
    context(widget, hair, "Edit"); assert.equal(widget.state.activeTab, "hair");
    menu = context(widget, hair);
    document.listeners.get("pointerdown")({ target: widget.editor });
    assert.equal(widget.libraryActions.popup, null);
    const dialog = context(widget, hair, "Delete");
    assert.equal(dialog.open, true);
    widget.events.abort(); assert.equal(widget.libraryActions.popup, null);
    assert.equal(document.body.children.length, 0);
    assert.ok(widget.state.blocks.some(block => block.id === "hair"));
});

test("block rename and deletion dialogs cancel without changes and keep catalog copies hidden after workflow restoration", async t => {
    const { widget } = setup(t), original = { id: "catalog", name: "Catalog block", text: "{~first|second}", category: "Clothes" };
    widget.defaultCards = [original]; widget.renderLibrary();
    const before = structuredClone(widget.state);
    let row = widget.list.children.find(row => row.dataset.blockId === "catalog");
    let dialog = context(widget, row, "Rename");
    dialog.listeners.get("cancel")(); assert.deepEqual(widget.state, before);
    dialog = context(widget, row, "Rename"); dialog.querySelector("input").value = "Renamed catalog";
    dialog.querySelector("form").listeners.get("submit")(); await new Promise(setImmediate);
    const renamed = widget.state.blocks.find(block => block.name === "Renamed catalog");
    assert.ok(renamed); assert.deepEqual(widget.state.parts, before.parts);
    assert.equal(widget.state.activeTab, before.activeTab);
    assert.ok(widget.node.properties.promptDesignerHiddenBlocks.length);
    assert.equal(widget.list.children.some(row => row.querySelector(".vnccs-pd-block-name")?.textContent === "Catalog block"), false);
    row = widget.list.children.find(row => row.dataset.blockId === renamed.id);
    dialog = context(widget, row, "Delete");
    dialog.querySelector("button").listeners.get("click")(); assert.ok(widget.state.blocks.includes(renamed));
    dialog = context(widget, row, "Delete");
    dialog.querySelector("form").listeners.get("submit")(); await new Promise(setImmediate);
    assert.equal(widget.state.blocks.some(block => block.id === renamed.id), false);
    const restoredNode = node(); restoredNode.properties = structuredClone(widget.node.properties);
    restoredNode.widgets[0].value = widget.node.widgets[0].value;
    const restored = new PromptDesignerWidget(restoredNode, widget.api);
    t.mock.method(restored, "schedulePreview", () => {}); t.mock.method(restored, "scheduleBlockPreview", () => {});
    t.after(() => { restored.events.abort(); restored.documentStorage?.dispose(); });
    await restoreFromNode.call(restored); restored.defaultCards = [original]; restored.renderLibrary();
    assert.equal(restored.list.children.some(row => row.dataset.blockId === "catalog"), false);
});

test("template context actions rename and delete the targeted snapshot without replacing another open prompt", async t => {
    const { widget, records } = setup(t); widget.editPromptDetails();
    widget.promptName.value = "First"; await widget.saveLibraryPrompt(); const first = widget.editingSavedPrompt.id;
    widget.promptName.value = "Second"; await widget.saveLibraryPrompt(true); const second = widget.editingSavedPrompt.id;
    const snapshot = structuredClone(records.get(first).state);
    widget.state.parts = [{ text: "my working draft" }]; widget.commit();
    const current = structuredClone(widget.state); widget.libraryView = "prompts"; widget.renderLibrary();
    let row = widget.list.children.find(row => row.dataset.promptId === first);
    let dialog = context(widget, row, "Rename"); dialog.querySelector("input").value = "Updated name";
    dialog.querySelector("form").listeners.get("submit")(); await new Promise(setImmediate);
    assert.deepEqual(records.get(first).state.parts, snapshot.parts);
    assert.equal(records.get(first).state.savedPrompt.name, "Updated name");
    assert.equal(records.get(second).state.savedPrompt.name, "Second");
    assert.equal(widget.editingSavedPrompt.id, second); assert.deepEqual(widget.state, current);
    row = widget.list.children.find(row => row.dataset.promptId === first);
    dialog = context(widget, row, "Delete"); dialog.listeners.get("cancel")();
    assert.ok(records.get(first).state.savedPrompt);
    dialog = context(widget, row, "Delete"); dialog.querySelector("form").listeners.get("submit")(); await new Promise(setImmediate);
    assert.equal(records.get(first).state.savedPrompt, undefined);
    assert.equal(widget.savedPrompts.some(prompt => prompt.id === first), false);
    assert.equal(widget.editingSavedPrompt.id, second); assert.deepEqual(widget.state, current);
});

test("rename errors remain visible in the modal and do not modify the template", async t => {
    const { widget, records } = setup(t); widget.editPromptDetails();
    widget.promptName.value = "Protected"; await widget.saveLibraryPrompt();
    const original = structuredClone([...records.values()][0]); widget.libraryView = "prompts"; widget.renderLibrary();
    const dialog = context(widget, widget.list.children[0], "Rename"); dialog.querySelector("input").value = "New name";
    widget.api.fetchApi = async () => Response.json({ error: "disk unavailable" }, { status: 500 });
    dialog.querySelector("form").listeners.get("submit")(); await new Promise(setImmediate);
    assert.equal(widget.libraryActions.popup.element, dialog);
    assert.match(dialog.querySelector(".error").textContent, /disk unavailable/);
    assert.equal(dialog.querySelector(".error").hidden, false);
    assert.deepEqual([...records.values()][0], original);
});

test("prompt details and library view survive reconstruction without restoring a default composition", async t => {
    const { widget } = setup(t); widget.editPromptDetails();
    widget.promptName.value = "My scene"; widget.promptCategory.value = "Backgrounds"; widget.promptColor.value = "#eeaa77";
    widget.savePromptDetails(); await widget.saveLibraryPrompt();
    widget.node.properties.promptDesignerLibraryTab = "prompts";
    widget.state.parts = [{ text: "my current unsaved-library composition" }]; widget.render(); widget.commit();
    const restoredNode = node(); restoredNode.widgets[0].value = widget.node.widgets[0].value;
    restoredNode.properties = structuredClone(widget.node.properties);
    const restored = new PromptDesignerWidget(restoredNode, widget.api);
    t.mock.method(restored, "schedulePreview", () => {}); t.mock.method(restored, "scheduleBlockPreview", () => {});
    t.after(() => { restored.events.abort(); restored.documentStorage?.dispose(); });
    await restoreFromNode.call(restored); restored.editPromptDetails(); await restored.loadSavedPrompts();
    assert.deepEqual(restored.state.parts, [{ text: "my current unsaved-library composition" }]);
    assert.equal(restored.promptName.value, "My scene");
    assert.equal(restored.promptCategory.value, "Backgrounds");
    assert.equal(restored.promptColor.value, "#eeaa77");
    assert.equal(restored.list.children[0].dataset.promptId, widget.editingSavedPrompt.id);
});

function template(records, id, name, parts = [{ text: name }]) {
    records.set(id, { revision: 1, state: { ...promptSnapshot(composed()), parts, savedPrompt: { name, category: "", color: "#44bb99" } } });
    return { id, name, revision: 1 };
}

test("opening templates creates independent tabs, repeat opening preserves edits, and all drafts survive reconstruction", async t => {
    const { widget, records } = setup(t);
    await restoreFromNode.call(widget); t.after(() => widget.documentStorage?.dispose());
    const original = widget.state.activePrompt, authored = structuredClone(widget.state.parts);
    const first = template(records, "a".repeat(32), "First"), second = template(records, "b".repeat(32), "Second");
    await widget.openSavedPrompt(first); const firstTab = widget.state.activePrompt;
    widget.state.parts = [{ text: "my first draft" }, { blockId: "hair" }]; widget.state.seed = "7"; widget.state.afterGenerate = "fixed";
    widget.render(); widget.commit();
    await widget.openSavedPrompt(second); const secondTab = widget.state.activePrompt;
    assert.equal(widget.state.promptTabs.length, 3);
    assert.deepEqual(widget.state.promptTabs.find(tab => tab.id === original).parts, authored);
    assert.equal(widget.state.parts[0].text, "Second");
    await widget.openSavedPrompt(first);
    assert.equal(widget.state.activePrompt, firstTab); assert.equal(widget.state.promptTabs.length, 3);
    assert.deepEqual(widget.state.parts, [{ text: "my first draft" }, { blockId: "hair" }]);
    assert.equal(widget.state.seed, "7"); assert.equal(widget.state.afterGenerate, "fixed");
    widget.switchPrompt(original); assert.deepEqual(widget.state.parts, authored);
    const restoredNode = node(); restoredNode.widgets[0].value = widget.serializeForPrompt();
    restoredNode.properties = structuredClone(widget.node.properties);
    assert.ok(widget.documentStorage.pending, "reload occurs before the workspace disk save is acknowledged");
    assert.equal(restoredNode.properties.promptDesigner.dirty, true);
    const restored = new PromptDesignerWidget(restoredNode, widget.api);
    t.mock.method(restored, "schedulePreview", () => {}); t.mock.method(restored, "scheduleBlockPreview", () => {});
    t.after(() => { restored.events.abort(); restored.documentStorage?.dispose(); });
    await restoreFromNode.call(restored);
    assert.deepEqual(JSON.parse(JSON.stringify(restored.state.promptTabs)), JSON.parse(restoredNode.widgets[0].value).promptTabs);
    restored.switchPrompt(firstTab); assert.equal(restored.state.parts[0].text, "my first draft"); assert.equal(restored.activePrompt().dirty, true);
    restored.switchPrompt(secondTab); assert.equal(restored.state.parts[0].text, "Second"); assert.equal(restored.activePrompt().dirty, false);
    assert.equal(restored.editingSavedPrompt.id, second.id);
});

test("closing an unsaved prompt offers Save, Discard and Cancel; save failure retains the exact draft and successful save closes it", async t => {
    const { widget, records } = setup(t), id = widget.state.activePrompt, parts = structuredClone(widget.state.parts);
    const tabElement = widget.tabs.children.find(tab => tab.dataset.tabId === `prompt:${id}`);
    tabElement.querySelector(".close").listeners.get("click")();
    let dialog = widget.libraryActions.popup.element;
    assert.deepEqual(dialog.querySelector(".actions").children.map(button => button.textContent), ["Cancel", "Discard", "Save"]);
    dialog.listeners.get("cancel")(); assert.deepEqual(widget.state.parts, parts); assert.equal(widget.state.activePrompt, id);
    widget.closePrompt(id); dialog = widget.libraryActions.popup.element;
    dialog.querySelector(".actions").children[0].listeners.get("click")(); assert.deepEqual(widget.state.parts, parts);
    widget.closePrompt(id); dialog = widget.libraryActions.popup.element; dialog.querySelector("input").value = "Saved composition";
    const fetch = widget.api.fetchApi;
    widget.api.fetchApi = async () => Response.json({ error: "disk full" }, { status: 500 });
    dialog.querySelector("form").listeners.get("submit")(); await new Promise(setImmediate);
    assert.equal(widget.libraryActions.popup.element, dialog); assert.match(dialog.querySelector(".error").textContent, /disk full/);
    assert.equal(widget.state.activePrompt, id); assert.deepEqual(widget.state.parts, parts); assert.equal(records.size, 0);
    widget.api.fetchApi = fetch;
    dialog.querySelector("form").listeners.get("submit")(); await new Promise(setImmediate);
    assert.equal(widget.libraryActions.popup, null); assert.equal(widget.state.promptTabs.some(tab => tab.id === id), false);
    assert.deepEqual(widget.state.parts, []); assert.equal(records.size, 1);
    const saved = [...records.values()][0].state;
    assert.deepEqual(saved.parts, parts); assert.equal(saved.blocks.length, 4); assert.equal(saved.savedPrompt.name, "Saved composition");
    assert.equal(saved.promptTabs, undefined, "a template includes its own document, not other open drafts");
});

test("clean templates close immediately; dirty background tabs can be saved or discarded without replacing the active prompt", async t => {
    const { widget, records } = setup(t), original = widget.state.activePrompt;
    await widget.openSavedPrompt(template(records, "a".repeat(32), "Clean")); const clean = widget.state.activePrompt;
    assert.equal(widget.activePrompt().dirty, false); widget.closePrompt(clean);
    assert.equal(widget.libraryActions.popup, undefined); assert.equal(widget.state.activePrompt, original);
    widget.newPrompt(); const background = widget.state.activePrompt;
    widget.state.parts = [{ text: "background edits" }]; widget.commit(); widget.switchPrompt(original);
    const before = structuredClone(widget.state.parts);
    widget.closePrompt(background); let dialog = widget.libraryActions.popup.element;
    dialog.querySelector("input").value = "Background"; dialog.querySelector("form").listeners.get("submit")(); await new Promise(setImmediate);
    assert.equal(widget.state.activePrompt, original); assert.deepEqual(widget.state.parts, before);
    assert.deepEqual([...records.values()].find(record => record.state.savedPrompt?.name === "Background").state.parts, [{ text: "background edits" }]);
    widget.closePrompt(original); dialog = widget.libraryActions.popup.element;
    dialog.querySelector(".actions").children[1].listeners.get("click")();
    assert.deepEqual(widget.state.parts, []); assert.equal(widget.libraryActions.popup, null);
});

test("save acknowledgements belong to the original tab and newer edits cannot be silently closed", async t => {
    const { widget } = setup(t), original = widget.state.activePrompt;
    widget.editPromptDetails(); widget.promptName.value = "Original";
    let complete; const fetch = widget.api.fetchApi;
    widget.api.fetchApi = (url, options) => options?.method === "PUT" ? new Promise(resolve => { complete = resolve; }) : fetch(url, options);
    const saving = widget.saveLibraryPrompt(); widget.newPrompt(); const other = widget.state.activePrompt;
    widget.state.parts = [{ text: "keep this second tab" }]; widget.commit();
    complete(Response.json({ revision: 1 })); assert.equal(await saving, true);
    assert.equal(widget.state.activePrompt, other); assert.equal(widget.editingSavedPrompt, null);
    assert.equal(widget.state.promptTabs.find(tab => tab.id === original).details.revision, 1);
    assert.equal(widget.state.promptTabs.find(tab => tab.id === original).dirty, false);
    widget.switchPrompt(original); widget.state.parts = [{ text: "edits before close" }]; widget.commit();
    widget.closePrompt(original); const dialog = widget.libraryActions.popup.element;
    dialog.querySelector("form").listeners.get("submit")();
    widget.state.parts = [{ text: "newer edits during save" }]; widget.commit();
    complete(Response.json({ revision: 2 })); await new Promise(setImmediate);
    assert.equal(widget.libraryActions.popup.element, dialog);
    assert.match(dialog.querySelector(".error").textContent, /Newer edits/);
    assert.equal(widget.state.parts[0].text, "newer edits during save"); assert.equal(widget.activePrompt().dirty, true);
});

test("undo and block deletion preserve inactive prompt drafts and references", t => {
    const { widget } = setup(t), original = widget.state.activePrompt, before = structuredClone(widget.state.parts);
    widget.state.parts = [{ text: "changed" }]; widget.commit();
    widget.newPrompt(); const second = widget.state.activePrompt;
    widget.state.parts = before; widget.commit(); widget.switchPrompt(original);
    widget.moveHistory("undo"); assert.deepEqual(widget.state.parts, before);
    assert.deepEqual(widget.state.promptTabs.find(tab => tab.id === second).parts, before);
    removeBlock(widget.state, "hair"); assert.ok(widget.commit());
    widget.switchPrompt(second); assert.equal(widget.state.parts[2].condition.blockId, "");
    assert.doesNotThrow(() => normalizeState(widget.state));
});

test("prompt undo and redo retain later shared card and category edits from another tab", t => {
    const { widget } = setup(t), original = widget.state.activePrompt, before = structuredClone(widget.state.parts);
    widget.state.parts = [{ text: "first prompt edit" }]; widget.commit();
    widget.newPrompt(); const second = widget.state.activePrompt;
    widget.state.parts = [{ blockId: "hair" }]; widget.commit();
    widget.openBlock("hair"); widget.saveBlockSource("new card text from second tab");
    widget.setBlockPreference("category", "Hair");
    widget.categoryColor.value = "#aabbcc"; widget.setCategoryColor();
    widget.switchPrompt(original);
    for (const direction of ["undo", "redo"]) {
        widget.moveHistory(direction);
        assert.deepEqual(widget.state.parts, direction === "undo" ? before : [{ text: "first prompt edit" }]);
        assert.equal(widget.state.blocks.find(block => block.id === "hair").text, "new card text from second tab");
        assert.equal(widget.state.categories.find(category => category.name === "Hair").color, "#aabbcc");
        assert.deepEqual(widget.state.promptTabs.find(tab => tab.id === second).parts, [{ blockId: "hair" }]);
    }
    widget.switchPrompt(second); widget.openBlock("hair");
    widget.saveBlockSource("latest card edit"); widget.moveHistory("undo");
    assert.equal(widget.state.blocks.find(block => block.id === "hair").text, "new card text from second tab");
    widget.moveHistory("redo");
    assert.equal(widget.state.blocks.find(block => block.id === "hair").text, "latest card edit");
});

test("shared card history reverts only its changed fields and preserves later edits to the same field", t => {
    const { widget } = setup(t), original = widget.state.activePrompt;
    const before = widget.state.blocks.find(block => block.id === "hair").text;
    widget.openBlock("hair"); widget.saveBlockSource("first tab text");
    widget.newPrompt(); const second = widget.state.activePrompt;
    widget.openBlock("hair"); widget.setBlockPreference("color", "#123abc");
    widget.switchPrompt(original);
    for (const direction of ["undo", "redo"]) {
        widget.moveHistory(direction);
        const block = widget.state.blocks.find(block => block.id === "hair");
        assert.equal(block.text, direction === "undo" ? before : "first tab text");
        assert.equal(block.color, "#123abc");
    }
    widget.switchPrompt(second); widget.openBlock("hair"); widget.saveBlockSource("newer second tab text");
    widget.switchPrompt(original);
    for (const direction of ["undo", "redo"]) {
        widget.moveHistory(direction);
        assert.equal(widget.state.blocks.find(block => block.id === "hair").text, "newer second tab text");
    }
});

test("undo retains a new card and category used by another draft while unused cards remain undoable", t => {
    const { widget } = setup(t), original = widget.state.activePrompt;
    widget.categoryName.value = "Shared"; widget.addCategory(); widget.newBlock();
    const id = widget.state.activeTab;
    widget.moveHistory("undo"); assert.ok(!widget.state.blocks.some(block => block.id === id));
    widget.moveHistory("redo"); assert.ok(widget.state.blocks.some(block => block.id === id));
    widget.newPrompt(); const second = widget.state.activePrompt;
    widget.state.parts = [{ blockId: id }]; widget.commit(); widget.switchPrompt(original);
    for (const direction of ["undo", "undo", "redo", "redo"]) {
        widget.moveHistory(direction);
        assert.ok(widget.state.blocks.some(block => block.id === id && block.category === "Shared"));
        assert.ok(widget.state.categories.some(category => category.name === "Shared"));
        assert.deepEqual(widget.state.promptTabs.find(tab => tab.id === second).parts, [{ blockId: id }]);
        assert.doesNotThrow(() => normalizeState(widget.state));
    }
});
