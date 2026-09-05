import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { FactoryCommandHistory } from "../web/factory3d/editor_commands.mjs";
import { FactoryPropertyGesture } from "../web/factory3d/core/property_gesture.mjs";
import { LIGHT_NUMERIC_PROPERTIES, acceptNumericDraft, readLightProperty, writeLightProperty } from "../web/factory3d/core/property_descriptors.mjs";
import { bindNumericPropertyInputs } from "../web/factory3d/ui/numeric_property_binding.mjs";
import { enqueueFactorySceneSave } from "../web/factory3d/core/save_queue.mjs";
import { normalizedLighting } from "../web/vnccs_3d_factory_viewer.js";
import { migrateEditorState, normalizedWorkspace, fitWorkspaceDocks } from "../web/factory3d/core/editor_migrations.mjs";
import { findFactoryCommands } from "../web/factory3d/ui/command_registry.mjs";
import { factoryCameraQuaternion, factoryCameraEuler } from "../web/factory3d/core/camera_rotation.mjs";
import { activateWorkspaceTab } from "../web/factory3d/ui/workspace.mjs";

test("Workspace tabs show only their own panel and preserve the other side and scroll", () => {
    const entries = [["left", "generate"], ["left", "cameras"], ["right", "objects"], ["right", "inspector"], ["right", "export"]];
    const buttons = entries.map(([side, tab]) => ({
        dataset: { workspaceSide: side, workspaceTab: tab },
        attributes: {}, setAttribute(key, value) { this.attributes[key] = value; },
    }));
    const panels = entries.map(([side, tab], index) => ({
        dataset: { workspaceSide: side, workspacePanel: tab }, hidden: false, scrollTop: index * 60,
    }));
    activateWorkspaceTab(buttons, panels, "left", "cameras");
    for (const tab of ["objects", "inspector", "export", "objects", "inspector"]) {
        const active = activateWorkspaceTab(buttons, panels, "right", tab);
        assert.equal(active.dataset.workspaceTab, tab);
        assert.deepEqual(panels.filter(panel => !panel.hidden).map(panel => panel.dataset.workspacePanel), ["cameras", tab]);
        assert.equal(buttons.filter(button => button.dataset.workspaceSide === "right" && button.tabIndex === 0).length, 1);
        assert.equal(active.attributes["aria-selected"], "true");
        assert.deepEqual(panels.map(panel => panel.scrollTop), [0, 60, 120, 180, 240]);
    }
});

const ref = { kind: "light", id: "a".repeat(32), sceneId: "b".repeat(32) };
function editor() {
    let light = { position: [0, 2, 0], intensity: 1, distance: 0 };
    const preview = [];
    const finished = [];
    const history = new FactoryCommandHistory({
        onRestore: snapshot => { light = structuredClone(snapshot); },
        onPatch: (patches, { direction }) => {
            for (const patch of patches) writeLightProperty(light, patch.path, direction === "undo" ? patch.before : patch.after);
        },
    });
    const read = (_, path) => readLightProperty(light, path);
    const gesture = new FactoryPropertyGesture({ history, read,
        write: (_, path, value) => writeLightProperty(light, path, value),
        preview: (_, path, value) => preview.push([path, value]),
        finish: (_, path, value, reason) => finished.push([path, value, reason]),
    });
    return { history, gesture, read, preview, finished, get light() { return light; } };
}

test("A live gesture stores one bounded patch and mixes correctly with legacy snapshot undo", () => {
    const e = editor();
    for (let value = 2; value <= 100; value++) e.gesture.input(ref, LIGHT_NUMERIC_PROPERTIES.intensity, String(value));
    assert.equal(e.light.intensity, 100);
    assert.equal(e.preview.length, 99);
    assert.equal(e.history.canUndo, false, "No command until the gesture commits");
    e.gesture.commit();
    e.gesture.commit();
    assert.equal(e.history.undoStack.length, 1);
    assert.ok(e.history.bytes < 500, "The command does not contain a scene snapshot");
    const before = structuredClone(e.light);
    e.light.distance = 25;
    e.history.push("Legacy edit", before, e.light);
    e.history.undo();
    assert.equal(e.light.distance, 0);
    assert.equal(e.light.intensity, 100);
    e.history.undo();
    assert.equal(e.light.intensity, 1);
    e.history.redo();
    e.history.redo();
    assert.equal(e.light.intensity, 100);
    assert.equal(e.light.distance, 25);
});

test("Cancel restores only the edited field; invalid drafts never become zero; no-op preserves redo", () => {
    const e = editor();
    e.gesture.input(ref, LIGHT_NUMERIC_PROPERTIES.intensity, "4");
    e.light.distance = 30;
    for (const draft of ["", " ", "-", ".", "1e", "Infinity", "NaN", "1+2"]) {
        assert.equal(e.gesture.input(ref, LIGHT_NUMERIC_PROPERTIES.intensity, draft).valid, false);
        assert.equal(e.light.intensity, 4);
    }
    e.gesture.cancel();
    assert.equal(e.light.intensity, 1);
    assert.equal(e.light.distance, 30);
    assert.equal(e.history.canUndo, false);
    e.gesture.input(ref, LIGHT_NUMERIC_PROPERTIES.intensity, "2");
    e.gesture.commit();
    e.history.undo();
    e.gesture.input(ref, LIGHT_NUMERIC_PROPERTIES.intensity, "1");
    assert.equal(e.gesture.commit(), false);
    assert.equal(e.history.canRedo, true);
    assert.throws(() => writeLightProperty(e.light, "__proto__.value", 3));
});

test("History enforces count and byte budgets across undo, redo and branching", () => {
    let discarded = 0;
    const history = new FactoryCommandHistory({ limit: 2, maxBytes: 600,
        onDiscard: count => { discarded += count; } });
    for (let value = 1; value <= 4; value++) history.pushPatch("Edit", [{ ref, path: "intensity", before: value - 1, after: value }]);
    assert.equal(history.undoStack.length, 2);
    assert.equal(discarded, 2);
    const bytes = history.bytes;
    history.undo(); history.redo();
    assert.equal(history.bytes, bytes);
    history.undo();
    history.pushPatch("Branch", [{ ref, path: "distance", before: 0, after: 5 }]);
    assert.equal(history.canRedo, false);
    assert.ok(history.bytes <= 600);
    history.push("Oversized", { data: "a".repeat(1000) }, { data: "b".repeat(1000) });
    assert.equal(history.bytes, 0);
    assert.equal(history.canUndo, false);
    history.clear();
    assert.equal(history.bytes, 0);
});

class Control extends EventTarget {
    constructor(type) {
        super(); this.type = type; this.value = "1"; this.min = "0"; this.max = "50";
        this.dataset = { editorPath: "light.intensity" }; this.attributes = new Map();
    }
    setAttribute(key, value) { this.attributes.set(key, value); }
    removeAttribute(key) { this.attributes.delete(key); }
    getAttribute(key) { return this.attributes.get(key); }
    setCustomValidity(value) { this.validationMessage = value; }
    send(type, extra = {}) { const event = new Event(type); Object.assign(event, extra); this.dispatchEvent(event); }
}

test("Numeric binding updates peers during input, clamps visibly, cancels Escape and releases listeners", () => {
    const e = editor();
    const range = new Control("range"), exact = new Control("number");
    let feedback = "";
    const cleanup = bindNumericPropertyInputs({ querySelectorAll: () => [range, exact] }, {
        descriptors: LIGHT_NUMERIC_PROPERTIES, ref, gesture: e.gesture, read: e.read,
        feedback: value => { feedback = value; },
    });
    range.value = "8"; range.send("input");
    assert.equal(exact.value, "8");
    assert.equal(e.light.intensity, 8);
    assert.equal(e.history.canUndo, false);
    range.send("pointerup"); range.send("change"); range.send("lostpointercapture");
    assert.equal(e.history.undoStack.length, 1);
    exact.value = "200000"; exact.send("input");
    assert.equal(e.light.intensity, 100000);
    assert.equal(exact.value, "100000");
    assert.equal(range.max, "100000");
    assert.match(feedback, /Limited/);
    exact.send("keydown", { key: "Escape" });
    assert.equal(e.light.intensity, 8);
    assert.equal(range.value, "8");
    exact.value = ""; exact.send("input");
    assert.equal(e.light.intensity, 8);
    assert.equal(exact.getAttribute("aria-invalid"), "true");
    exact.send("blur");
    assert.equal(exact.value, "8");
    range.value = "9"; range.send("input"); range.send("pointercancel");
    assert.equal(e.light.intensity, 8);
    range.value = "10"; range.send("input");
    cleanup({ cancel: true });
    assert.equal(e.light.intensity, 8);
    range.value = "20"; range.send("input");
    assert.equal(e.light.intensity, 8);
});

test("Queued saves freeze scene ownership and nested values and recover after a failed request", async () => {
    let release;
    const blocked = new Promise(resolve => { release = resolve; });
    const sent = [];
    const payload = { lighting: { lights: [{ intensity: 1 }] } };
    const send = async (id, value) => { sent.push([id, value]); return id; };
    const first = enqueueFactorySceneSave(blocked, "scene-a", payload, send);
    payload.lighting.lights[0].intensity = 9;
    const second = enqueueFactorySceneSave(first, "scene-b", payload, send);
    payload.lighting.lights.length = 0;
    release();
    await second;
    assert.deepEqual(sent.map(([id, data]) => [id, data.lighting.lights[0].intensity]), [["scene-a", 1], ["scene-b", 9]]);
    const failed = enqueueFactorySceneSave(second, "scene-b", {}, async () => { throw new Error("Offline"); });
    const recovered = enqueueFactorySceneSave(failed, "scene-c", {}, send);
    await assert.rejects(failed, /Offline/);
    assert.equal(await recovered, "scene-c");
});

test("Shared numeric contract cases agree with accepted UI values and the viewer normalizer", () => {
    const cases = JSON.parse(fs.readFileSync(new URL("./fixtures/factory3d/light_numeric_contract.json", import.meta.url)));
    for (const item of cases) {
        const descriptor = LIGHT_NUMERIC_PROPERTIES[item.path];
        const accepted = acceptNumericDraft(descriptor, item.input);
        assert.equal(accepted.value, item.expected, item.name);
        const light = { light_id: ref.id, position: [0, 2, 0], intensity: 1, distance: 0 };
        writeLightProperty(light, item.path, accepted.value);
        const normalized = normalizedLighting({ lights: [light] }).lights[0];
        assert.equal(readLightProperty(normalized, item.path), item.expected, item.name);
    }
});

test("Units and relative edits use the gesture start, never accumulate repeated previews", () => {
    const e = editor();
    const descriptor = LIGHT_NUMERIC_PROPERTIES["position.1"];
    e.gesture.input(ref, descriptor, "+=25cm");
    assert.equal(e.light.position[1], 2.25);
    e.gesture.input(ref, descriptor, "+=50cm");
    assert.equal(e.light.position[1], 2.5);
    e.gesture.input(ref, descriptor, "/=2");
    assert.equal(e.light.position[1], 1);
    assert.equal(e.gesture.input(ref, descriptor, "/=0").valid, false);
    assert.equal(e.gesture.input(ref, descriptor, "15deg").valid, false);
    e.gesture.cancel();
    assert.equal(e.light.position[1], 2);
});

test("Editor migration is pure, idempotent, preserves scene geometry and rejects future versions", () => {
    const original = { schema_version: 17, scene_id: ref.sceneId,
        scene_snapshot: { schema_version: 11, objects: [{ transform: { position: [3, 5, 8], scale: 2 } }] },
        editor_view: { workspace: { left: "cameras", right: "export" }, plan_camera: { zoom: 9 } } };
    const before = structuredClone(original);
    const migrated = migrateEditorState(original);
    assert.deepEqual(original, before);
    assert.equal(migrated.schema_version, 18);
    assert.deepEqual(migrated.scene_snapshot, original.scene_snapshot);
    assert.deepEqual(migrateEditorState(migrated), migrated);
    assert.equal(migrated.editor_view.workspace.left, "cameras");
    assert.equal(migrated.editor_view.workspace.docked, true);
    assert.throws(() => migrateEditorState({ schema_version: 999 }), /Unsupported/);
    assert.equal(normalizedWorkspace({ right_width: 5000 }).right_width, 480);
    assert.equal(normalizedWorkspace({ tree_fraction: -10 }).tree_fraction, 0.2);
    assert.equal(findFactoryCommands("door")[0].id, "opening");
    assert.equal(findFactoryCommands("no such tool").length, 0);
});

test("Camera angle helpers preserve rolled poses beyond 90 degrees of yaw", () => {
    for (const rotation of [[15, 130, 23], [-40, -170, -28], [89.9, 45, 30]]) {
        const q = factoryCameraQuaternion(rotation);
        const restored = factoryCameraQuaternion(factoryCameraEuler(q));
        const dot = q.reduce((sum, value, index) => sum + value * restored[index], 0);
        assert.ok(Math.abs(Math.abs(dot) - 1) < 1e-9);
    }
});

test("Label scrubbing previews before pointer release, cancels and resets through the same history", () => {
    const e = editor(), range = new Control("range"), exact = new Control("text"), scrub = new Control("button"), reset = new Control("button");
    scrub.dataset = { numericScrub: "light.intensity" };
    reset.dataset = { numericReset: "light.intensity" };
    scrub.offsetWidth = 100;
    scrub.getBoundingClientRect = () => ({ width: 200 }); // Graph zoom must not double the step.
    scrub.focus = () => {};
    scrub.setPointerCapture = id => { scrub.capture = id; };
    scrub.hasPointerCapture = id => scrub.capture === id;
    scrub.releasePointerCapture = () => { scrub.capture = null; };
    const root = { querySelectorAll: selector => selector === "[data-editor-path]" ? [range, exact]
        : selector === "[data-numeric-scrub]" ? [scrub] : [reset] };
    const cleanup = bindNumericPropertyInputs(root, { descriptors: LIGHT_NUMERIC_PROPERTIES, ref, gesture: e.gesture, read: e.read, feedback: () => {} });
    scrub.send("pointerdown", { button: 0, pointerId: 7, clientX: 100 });
    scrub.send("pointermove", { pointerId: 7, clientX: 140 });
    assert.equal(e.light.intensity, 3);
    assert.equal(exact.value, "3");
    assert.equal(e.history.canUndo, false);
    scrub.send("pointercancel");
    assert.equal(e.light.intensity, 1);
    assert.equal(scrub.capture, null);
    scrub.send("pointerdown", { button: 0, pointerId: 8, clientX: 100 });
    scrub.send("pointermove", { pointerId: 8, clientX: 140 });
    scrub.send("pointerup");
    assert.equal(e.history.undoStack.length, 1);
    reset.send("click");
    assert.equal(e.light.intensity, 1);
    e.history.undo();
    assert.equal(e.light.intensity, 3);
    cleanup();
});

test("Docks fit the node without losing persisted dimensions", () => {
    const state = normalizedWorkspace({ left_width: 420, right_width: 480 });
    const fitted = fitWorkspaceDocks(state, 980);
    assert.ok(fitted.left + fitted.right <= 660.000001);
    assert.equal(state.left_width, 420);
    assert.deepEqual(fitWorkspaceDocks(state, 1400), { left: 420, right: 480 });
});
