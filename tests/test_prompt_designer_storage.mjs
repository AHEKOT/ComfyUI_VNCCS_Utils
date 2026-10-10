import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { defaultState } from "../web/prompt_designer/state.mjs";
import { DocumentStorage } from "../web/prompt_designer/storage.mjs";
import { PromptDesignerWidget } from "../web/prompt_designer/widget.mjs";
import { readPromptResponse } from "../web/prompt_designer/response.mjs";

const identifier = "a".repeat(32);
const key = "vnccs:prompt-designer:" + identifier;
const reply = (data, status = 200) => ({ status, ok: status < 400, json: async () => data });
const memory = () => {
    const values = new Map();
    return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
};
const documentNode = state => ({ properties: { promptDesigner: { id: identifier, revision: 1, state: JSON.stringify(state) } } });
const editedState = () => {
    const state = defaultState();
    state.blocks.push({ id: "a", name: "Authored", text: "{@first|second}", mode: "cycle", color: "#f28ab2" });
    return { ...state, parts: [{ text: "my authored text\n\nlast" }] };
};

test("equal disk revisions and newer disk acknowledgements cannot replace pending workflow edits", async () => {
    const changed = editedState(), old = defaultState();
    for (const [revision, dirty] of [[1, undefined], [1, true], [2, true]]) {
        const node = documentNode(changed);
        node.properties.promptDesigner.dirty = dirty;
        const store = new DocumentStorage(node, { fetchApi: async () => reply({ revision, state: old }) }, () => {}, memory());
        assert.deepEqual(await store.restore(JSON.stringify(changed)), changed);
    }
    const pending = documentNode(changed), local = memory();
    pending.properties.promptDesigner.dirty = true;
    local.setItem(key, JSON.stringify({ state: JSON.stringify(old), revision: 2, dirty: false }));
    const pendingStore = new DocumentStorage(pending, { fetchApi: async () => reply({ revision: 2, state: old }) }, () => {}, local);
    assert.deepEqual(await pendingStore.restore(JSON.stringify(changed)), changed);
    const node = documentNode(old);
    node.properties.promptDesigner.dirty = false;
    const store = new DocumentStorage(node, { fetchApi: async () => reply({ revision: 2, state: changed }) }, () => {}, memory());
    assert.deepEqual(await store.restore(JSON.stringify(old)), changed);
});

test("pending workflow metadata survives failed disk and browser writes and clears only after acknowledgement", async t => {
    const node = documentNode(defaultState()), changed = JSON.stringify(editedState());
    const local = { getItem: () => null, setItem: () => { throw new Error("quota exceeded"); } };
    let failed = true, changes = 0;
    node.graph = { change() { changes++; } };
    const store = new DocumentStorage(node, { fetchApi: async () => failed ? reply({ error: "disk full" }, 500) : reply({ revision: 2 }) }, () => {}, local);
    t.after(() => { store.disposed = true; clearTimeout(store.timer); });
    store.write(changed);
    await store.flush();
    assert.equal(node.properties.promptDesigner.dirty, true);
    assert.equal(node.properties.promptDesigner.state, changed);
    failed = false;
    await store.flush();
    assert.equal(node.properties.promptDesigner.dirty, false);
    assert.equal(node.properties.promptDesigner.state, changed);
    assert.equal(changes, 1);
});

test("plain HTTP error responses report the unavailable backend instead of a JSON syntax error", async () => {
    for (const status of [404, 405]) {
        const response = new Response(`${status}: ${status === 404 ? "Not Found" : "Method Not Allowed"}`, { status });
        await assert.rejects(readPromptResponse(response), error =>
            error.status === status && error.message.includes(`backend routes are unavailable (HTTP ${status})`));
    }
    await assert.rejects(readPromptResponse(new Response("<html>proxy error</html>", { status: 502 })), /HTTP 502/);
});

test("missing backend routes retain the pending draft and stop the repeated save requests", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const local = memory(), changed = JSON.stringify(editedState()), statuses = [];
    let missing = true, requests = 0;
    const store = new DocumentStorage(documentNode(defaultState()), { fetchApi: async () => {
        requests++;
        return missing ? new Response("405: Method Not Allowed", { status: 405 }) : reply({ revision: 2 });
    } }, message => statuses.push(message), local);
    t.after(() => { store.disposed = true; clearTimeout(store.timer); });
    store.write(changed);
    await store.flush();
    t.mock.timers.tick(30_000);
    assert.equal(requests, 1);
    assert.equal(store.pending, changed);
    assert.equal(JSON.parse(local.getItem(key)).dirty, true);
    assert.match(statuses.at(-1), /Not saved on disk.*HTTP 405.*Your draft is retained/);
    missing = false;
    await store.flush();
    assert.equal(store.pending, null);
    assert.equal(JSON.parse(local.getItem(key)).dirty, false);
});

test("a malformed success response cannot acknowledge or discard an authored draft", async t => {
    for (const data of [{}, { revision: -1 }, { revision: "2" }, { revision: null }]) {
        const local = memory(), changed = JSON.stringify(editedState()), statuses = [];
        const store = new DocumentStorage(documentNode(defaultState()), { fetchApi: async () => reply(data) }, message => statuses.push(message), local);
        t.after(() => { store.disposed = true; clearTimeout(store.timer); });
        store.write(changed);
        await store.flush();
        assert.equal(store.pending, changed);
        assert.equal(store.revision, 1);
        assert.equal(JSON.parse(local.getItem(key)).dirty, true);
        assert.match(statuses.at(-1), /Invalid disk save acknowledgement/);
    }
});

test("reload before the save request preserves the synchronous draft instead of stale workflow or disk state", async t => {
    const local = memory(), old = defaultState(), changed = editedState();
    const api = { fetchApi: async () => reply({ revision: 1, state: old }) };
    const original = new DocumentStorage(documentNode(old), api, () => {}, local);
    t.after(() => { original.disposed = true; clearTimeout(original.timer); });
    original.write(JSON.stringify(changed));
    assert.equal(JSON.parse(local.getItem(key)).dirty, true);
    const reloaded = new DocumentStorage(documentNode(old), api, () => {}, local);
    assert.deepEqual(await reloaded.restore(JSON.stringify(old)), changed);
    assert.equal(reloaded.revision, 1);
});

test("successful disk acknowledgement updates recovery revision; disk failures retain the draft", async t => {
    const local = memory(), changed = editedState(), statuses = [];
    let failed = true;
    const api = { fetchApi: async (url, options) => {
        assert.equal(options.method, "PUT");
        assert.equal(JSON.parse(options.body).revision, 1);
        return failed ? reply({ error: "disk full" }, 500) : reply({ revision: 2 });
    } };
    const store = new DocumentStorage(documentNode(defaultState()), api, (...args) => statuses.push(args), local);
    t.after(() => { store.disposed = true; clearTimeout(store.timer); });
    store.write(JSON.stringify(changed));
    await store.flush();
    assert.equal(store.pending, JSON.stringify(changed));
    assert.equal(JSON.parse(local.getItem(key)).dirty, true);
    assert.match(statuses.at(-1)[0], /Not saved on disk.*disk full/);
    failed = false;
    await store.flush();
    assert.equal(store.pending, null);
    assert.equal(store.node.properties.promptDesigner.revision, 2);
    assert.deepEqual(JSON.parse(local.getItem(key)), { state: JSON.stringify(changed), revision: 2, dirty: false });
});

test("disk state recovers across browsers; invalid browser data is archived before writing", async t => {
    const local = memory(), changed = editedState();
    local.setItem(key, "bad recovery JSON");
    const store = new DocumentStorage(documentNode(defaultState()), { fetchApi: async () => reply({ revision: 5, state: changed }) }, () => {}, local);
    t.after(() => { store.disposed = true; clearTimeout(store.timer); });
    assert.deepEqual(await store.restore("bad workflow JSON"), changed);
    assert.equal(store.revision, 5);
    assert.equal(local.getItem(key), "bad recovery JSON");
    store.write(JSON.stringify(changed));
    assert.ok([...local.values].some(([key, value]) => key.includes(":corrupt:") && value === "bad recovery JSON"));
});

test("damaged browser draft metadata cannot block newer disk recovery or poison autosave revisions", async t => {
    const changed = editedState();
    for (const metadata of [{ revision: -1, dirty: true }, { revision: 1, dirty: "false" }]) {
        const local = memory(), statuses = [];
        const damaged = JSON.stringify({ state: JSON.stringify(defaultState()), ...metadata });
        local.setItem(key, damaged);
        const store = new DocumentStorage(documentNode(defaultState()), {
            fetchApi: async (_, options) => options?.method === "PUT" ? reply({ revision: 3 }) : reply({ revision: 2, state: changed }),
        }, message => statuses.push(message), local);
        t.after(() => { store.disposed = true; clearTimeout(store.timer); });
        assert.deepEqual(await store.restore("{}"), changed);
        assert.equal(store.revision, 2);
        assert.match(statuses[0], /Browser recovery could not be read.*Recovery data was retained/);
        assert.equal(local.getItem(key), damaged);
        store.write(JSON.stringify(changed));
        assert.ok([...local.values].some(([key, value]) => key.includes(":corrupt:") && value === damaged));
        await store.flush();
        assert.equal(store.pending, null);
    }
});

test("failed restoration never fabricates or persists defaults over saved data", async () => {
    const local = memory();
    const node = documentNode(defaultState());
    node.properties.promptDesigner.state = "broken saved data";
    const store = new DocumentStorage(node, { fetchApi: async () => reply({ error: "server unavailable" }, 500) }, () => {}, local);
    await assert.rejects(store.restore("broken workflow JSON"));
    assert.equal(node.properties.promptDesigner.state, "broken saved data");
    assert.equal(local.values.size, 0);
});

test("concurrent edits fork the document and preserve both recovery keys", async t => {
    const local = memory(), statuses = [], requests = [];
    let conflict = true;
    const store = new DocumentStorage(documentNode(defaultState()), { fetchApi: async (url, options) => {
        requests.push([url, JSON.parse(options.body)]);
        return conflict ? reply({ error: "newer revision" }, 409) : reply({ revision: 1 });
    } }, (...args) => statuses.push(args), local);
    t.after(() => { store.disposed = true; clearTimeout(store.timer); });
    store.write(JSON.stringify(editedState()));
    await store.flush();
    assert.notEqual(store.id, identifier);
    assert.equal(store.revision, 0);
    assert.equal(local.getItem(key), local.getItem("vnccs:prompt-designer:" + store.id)?.replace('"revision":0', '"revision":1'));
    conflict = false;
    await store.flush();
    assert.equal(requests[1][1].revision, 0);
    assert.equal(store.node.properties.promptDesigner.id, store.id);
    assert.equal(store.pending, null);
});

test("simultaneous tabs retain their own pending draft when both reload before disk acknowledgement", async t => {
    const local = memory(), firstSession = memory(), secondSession = memory();
    const old = defaultState(), first = editedState(), second = { ...editedState(), parts: [{ text: "second tab" }] };
    const api = { fetchApi: async () => reply({ state: old, revision: 1 }) };
    const a = new DocumentStorage(documentNode(old), api, () => {}, local, firstSession);
    const b = new DocumentStorage(documentNode(old), api, () => {}, local, secondSession);
    t.after(() => { for (const store of [a, b]) { store.disposed = true; clearTimeout(store.timer); } });
    a.write(JSON.stringify(first));
    b.write(JSON.stringify(second));
    assert.deepEqual(await new DocumentStorage(documentNode(old), api, () => {}, local, firstSession).restore(JSON.stringify(old)), first);
    assert.deepEqual(await new DocumentStorage(documentNode(old), api, () => {}, local, secondSession).restore(JSON.stringify(old)), second);
});

test("cloned nodes get separate disk identities; acknowledged old drafts cannot replace newer workflow metadata", async () => {
    const local = memory(), node = documentNode(editedState());
    node.properties.promptDesigner.revision = 3;
    local.setItem(key, JSON.stringify({ state: JSON.stringify(defaultState()), revision: 1, dirty: false }));
    const api = { fetchApi: async () => reply({ revision: 0, state: null }) };
    assert.deepEqual(await new DocumentStorage(node, api, () => {}, local).restore("{}"), editedState());
    node.graph = { _nodes: [node, documentNode(defaultState())] };
    const clone = new DocumentStorage(node, api, () => {}, local);
    assert.notEqual(clone.id, identifier);
});

test("browser quota errors remain visible and disk persistence still works", async t => {
    const local = { getItem: () => null, setItem: () => { throw new Error("quota exceeded"); } };
    const statuses = [];
    const store = new DocumentStorage(documentNode(defaultState()), { fetchApi: async () => reply({ revision: 2 }) }, (...args) => statuses.push(args), local);
    t.after(() => { store.disposed = true; clearTimeout(store.timer); });
    store.write(JSON.stringify(editedState()));
    assert.match(statuses.at(-1)[0], /Browser backup failed/);
    await store.flush();
    assert.equal(store.pending, null);
    assert.match(statuses.at(-1)[0], /Saved on disk.*unavailable/);
});

test("serialization and constructor restoration cannot overwrite state before configure; dirty notifications do not recurse", async t => {
    const widget = Object.create(PromptDesignerWidget.prototype);
    const raw = JSON.stringify(editedState());
    const hidden = { name: "node_state", value: raw };
    widget.node = { widgets: [hidden], graph: { change() { widget.persist(); } } };
    widget.copy = {};
    widget.container = {};
    widget.render = () => {};
    await widget.loadFromNode(true);
    assert.equal(hidden.value, raw);
    assert.equal(widget.container.inert, true);
    assert.equal(widget.persist(), undefined);
    assert.throws(() => widget.serializeForPrompt(), /restoration is not complete/);
    widget.container.inert = false;
    widget.state = editedState();
    const persisted = widget.persist();
    const migrated = JSON.parse(persisted);
    assert.deepEqual(migrated.promptTabs[0].parts, JSON.parse(raw).parts);
    assert.equal(migrated.activePrompt, migrated.promptTabs[0].id);
    delete migrated.promptTabs; delete migrated.activePrompt;
    assert.deepEqual(migrated, JSON.parse(raw));
    assert.equal(hidden.value, persisted);
});

test("in-flight old saves cannot modify a reconfigured node's property mirror", async t => {
    const local = memory(), node = documentNode(defaultState());
    let respond;
    const store = new DocumentStorage(node, { fetchApi: () => new Promise(resolve => { respond = resolve; }) }, () => {}, local);
    store.write(JSON.stringify(editedState()));
    const save = store.flush();
    store.dispose();
    const next = { id: "b".repeat(32), revision: 0, state: "new workflow" };
    node.properties.promptDesigner = next;
    respond(reply({ revision: 2 }));
    await save;
    assert.equal(node.properties.promptDesigner, next);
    assert.equal(JSON.parse(local.getItem(key)).revision, 1);
    assert.equal(JSON.parse(local.getItem(key)).dirty, true);
    assert.equal(JSON.parse(local.getItem(`${key}:draft:${store.writer}`)).revision, 2);
    assert.equal(JSON.parse(local.getItem(`${key}:draft:${store.writer}`)).dirty, false);
});

test("a retired writer cannot redirect recovery away from newer pending edits", async t => {
    const local = memory(), session = memory(), old = defaultState(), changed = editedState();
    let respond;
    const api = { fetchApi: (_, options) => options?.method === "PUT"
        ? new Promise(resolve => { respond = resolve; }) : Promise.resolve(reply({ revision: 1, state: old })) };
    const first = new DocumentStorage(documentNode(old), api, () => {}, local, session);
    first.write(JSON.stringify(old));
    const saving = first.flush(); first.dispose();
    const next = new DocumentStorage(documentNode(old), api, () => {}, local, session);
    t.after(() => { next.disposed = true; clearTimeout(next.timer); });
    await next.restore(JSON.stringify(old));
    next.write(JSON.stringify(changed));
    respond(reply({ revision: 2 })); await saving;
    assert.equal(session.getItem(key), next.writer);
    assert.equal(JSON.parse(local.getItem(key)).state, JSON.stringify(changed));
    assert.equal(JSON.parse(local.getItem(`${key}:draft:${first.writer}`)).revision, 2);
    const reloaded = new DocumentStorage(documentNode(old), api, () => {}, local, session);
    assert.deepEqual(await reloaded.restore(JSON.stringify(old)), changed);
});

test("late restoration cannot overwrite a newly configured workflow before or after its own restoration", async t => {
    for (const finishNewFirst of [false, true]) {
        const old = { ...defaultState(), parts: [{ text: "OLD WORKFLOW" }] };
        const next = { ...defaultState(), parts: [{ text: "NEW WORKFLOW" }] };
        const hidden = { name: "node_state", value: JSON.stringify(old) }, requests = [];
        const widget = Object.create(PromptDesignerWidget.prototype);
        widget.node = { widgets: [hidden], ...documentNode(old) };
        widget.api = { fetchApi: (_, options) => new Promise(resolve => requests.push({ resolve, signal: options.signal })) };
        widget.copy = {}; widget.container = {}; widget.revision = 0;
        widget.render = widget.setStatus = widget.hideInspector = widget.loadLibraryCards = () => {};
        widget.restorePromptDetails = () => {};
        widget.commit = () => { hidden.value = JSON.stringify(widget.state); };
        const pending = widget.loadFromNode();
        const oldStorage = widget.documentStorage;
        hidden.value = JSON.stringify(next);
        widget.node.properties = documentNode(next).properties;
        const metadata = widget.node.properties.promptDesigner;
        widget.invalidateRestore();
        assert.equal(oldStorage.disposed, true);
        assert.equal(requests[0].signal.aborted, true);
        assert.equal(widget.container.inert, true);
        let loading;
        if (finishNewFirst) {
            loading = widget.loadFromNode();
            requests[1].resolve(reply({ revision: 2, state: next }));
            await loading;
            assert.deepEqual(widget.state.parts, next.parts);
        }
        const configuredRaw = hidden.value;
        requests[0].resolve(reply({ revision: 3, state: old }));
        await pending;
        assert.equal(hidden.value, configuredRaw);
        assert.equal(widget.node.properties.promptDesigner, metadata);
        if (!finishNewFirst) {
            assert.equal(widget.container.inert, true, "stale completion must not unlock the pending new workflow");
            loading = widget.loadFromNode();
            requests[1].resolve(reply({ revision: 2, state: next }));
            await loading;
        }
        assert.deepEqual(widget.state.promptTabs[0].parts, next.parts);
        const { promptTabs, activePrompt, ...restored } = widget.state;
        assert.deepEqual(restored, next);
        assert.equal(widget.container.inert, false);
        widget.documentStorage.dispose();
    }
});

test("ComfyUI lifecycle hooks restore configured values once and write the actual serialized payload", async () => {
    const source = await readFile(new URL("../web/vnccs_prompt_designer.js", import.meta.url), "utf8");
    const timers = new Map();
    let extension, sequence = 0, loads = 0;
    class Widget {
        constructor(node) { this.node = node; this.container = { style: {} }; this.events = new AbortController(); }
        on() {}
        invalidateRestore() { this.container.inert = true; }
        loadFromNode() { loads++; this.state = JSON.parse(this.node.widgets[0].value); }
        serializeForPrompt() { return this.persist(); }
        persist() {
            const value = JSON.stringify(this.state);
            this.node.widgets[0].value = value;
            return value;
        }
    }
    runInNewContext(source.replace(/^import .*;$/gm, ""), {
        app: { registerExtension: value => { extension = value; } }, api: {}, PromptDesignerWidget: Widget, window: {}, syncPromptOutputs() {}, AbortController,
        setTimeout: fn => { const id = ++sequence; timers.set(id, fn); return id; },
        clearTimeout: id => timers.delete(id),
    });
    class Node {
        constructor() {
            this.widgets = [{ name: "node_state", value: "{}" }];
            this.properties = { promptDesigner: { id: identifier } };
            this.size = [1100, 740];
        }
        addDOMWidget() {}
        setSize(value) { this.size = value; }
        onConfigure() {
            assert.equal(this.promptDesigner.container.inert, true, "invalidate old restoration before the original configure hook");
            this.originalConfigured = true;
        }
        onSerialize(info) { info.originalSerialized = true; }
    }
    extension.beforeRegisterNodeDef(Node, { name: "VNCCS_PromptDesigner" });
    const node = new Node();
    node.onNodeCreated();
    assert.equal(node.widgets[0].value, "{}");
    assert.equal(loads, 0);
    node.promptDesigner.container.inert = true;
    assert.equal(node.widgets[0].serializeValue(), "{}", "workflow autosave retains raw state during initialization");
    node.promptDesigner.container.inert = false;
    node.widgets[0].value = JSON.stringify(editedState());
    node.onConfigure();
    assert.equal(node.originalConfigured, true);
    assert.equal(timers.size, 1, "new-node initialization must be canceled by configuration");
    for (const callback of timers.values()) callback();
    assert.equal(loads, 1);
    assert.deepEqual(node.promptDesigner.state, editedState());
    const info = { widgets_values: ["stale value"], properties: {} };
    node.onSerialize(info);
    assert.equal(info.widgets_values[0], JSON.stringify(editedState()));
    assert.equal(info.originalSerialized, true);
    assert.equal(info.properties.promptDesigner.id, identifier);
    node.promptDesigner.restoreError = new Error("invalid saved data");
    node.widgets[0].value = "damaged authored state";
    assert.equal(node.widgets[0].serializeValue(), "damaged authored state");
});

test("an older queued execution cannot replace the latest preview or remove the original execution hook", async () => {
    let extension;
    const source = await readFile(new URL("../web/vnccs_prompt_designer.js", import.meta.url), "utf8");
    runInNewContext(source.replace(/^import .*;$/gm, ""), { app: { registerExtension(value) { extension = value; } } });
    class Node { onExecuted(message) { this.executed = message; } }
    extension.beforeRegisterNodeDef(Node, { name: "VNCCS_PromptDesigner" });
    const widget = Object.create(PromptDesignerWidget.prototype);
    widget.state = { ...defaultState(), afterGenerate: "fixed", blocks: [{ id: "color", name: "Color", text: "{@red|blue}" }],
        parts: [{ blockId: "color" }] };
    widget.seed = { value: "0" }; widget.revision = 0;
    widget.commit = () => { widget.revision++; };
    widget.persist = () => JSON.stringify(widget.state);
    widget.showResolvedPrompts = prompts => { widget.visible = prompts; };
    widget.prepareForQueue(); widget.prepareForQueue();
    widget.visible = ["blue"];
    const node = new Node(); node.promptDesigner = widget;
    const old = { prompt: ["red"], prompts: ["red"] };
    node.onExecuted(old);
    assert.deepEqual(widget.visible, ["blue"]);
    assert.equal(node.executed, old);
});
